import { afterAll, describe, expect, it } from "vitest";
import { confirmSnapshot, createSnapshotFromParsed } from "@/services/portfolio";
import { issueAdvice } from "@/services/advice";
import { recordAdvisedOffline, resolveMatch, runReconciliation, settleSipInstalments, RECORDED_AS_ADVISED } from "@/services/reconciliation";
import { clientWithActivePlan, parsed, progress, scenario, sql, TEST_DB } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});

describeDb("A SIP instalment is never a trade to decide", () => {
  it("is read as a SIP instalment, cannot be recorded as a call, and an older call made from one is undone", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx); // plan: SELL X ₹10L, BUY Y ₹6L
      const y = (await ctx.tx<{ scheme_name: string; isin: string }[]>`select scheme_name, isin from public.security_master where id = ${ctx.sec.Y}`)[0];
      const x = (await ctx.tx<{ scheme_name: string; isin: string }[]>`select scheme_name, isin from public.security_master where id = ${ctx.sec.X}`)[0];
      const snap = await ctx.as("ops", async (t) => {
        const pr = parsed("2026-10-12", [{ security: ctx.sec.X, name: x.scheme_name, units: 10000, nav: 150 }, { security: ctx.sec.Y, name: y.scheme_name, units: 100, nav: 150 }], [
          // Stored as a plain purchase (as an older reader did), worded as a SIP by the RTA.
          { date: "2026-10-12", type: "PURCHASE", description: "Net Systematic Purchase - Instalment 2/360 - via Internet", scheme_name: y.scheme_name, isin: y.isin, folio_number: "9722760/08", amount: 14999.25, units: 100, nav: 149.99, balance_units: 100 },
        ]);
        pr.holdings[0].isin = x.isin;
        pr.holdings[1].isin = y.isin;
        const id = await createSnapshotFromParsed(t, { clientId: p.clientId, casDocumentId: null, parsed: pr, source: "CAS", createdBy: ctx.users.ops.id });
        await confirmSnapshot(t, id, "checked");
        return id;
      });
      const { runId } = await ctx.as("ops", (t) => runReconciliation(t, ctx.users.ops, { clientId: p.clientId, currentSnapshotId: snap }));
      const row = (await ctx.tx<{ id: string; classification: string; cas_transaction_id: string }[]>`
        select id, classification, cas_transaction_id from public.reconciliation_matches where run_id = ${runId}`)[0];
      expect(row.classification).toBe("SIP_INSTALMENT");

      // The state an older reader left: the instalment as an unadvised trade, recorded as a call ("We advised it").
      await ctx.tx`update public.reconciliation_matches set classification = 'UNADVISED', reviewed_at = null where id = ${row.id}`;
      await expect(ctx.as("advisor", (t) => recordAdvisedOffline(t, ctx.users.advisor, row.id, { channel: "PHONE" }))).rejects.toThrow(/SIP instalment/);
      const b = await ctx.as("advisor", (t) => issueAdvice(t, ctx.users.advisor, {
        clientId: p.clientId, communicatedAt: new Date("2026-10-12T09:00:00+05:30"), channel: "PHONE",
        notes: "Recorded after the trade: advised outside the dashboard",
        items: [{ security_id: ctx.sec.Y, scheme_name: y.scheme_name, action: "BUY", quantity_basis: "AMOUNT", advised_amount: 14999.25 }],
      }));
      const am = (await ctx.tx<{ id: string }[]>`
        insert into public.reconciliation_matches (run_id, client_id, security_id, scheme_name, folio_numbers, change_type, detected_change,
          approx_amount, advice_item_id, classification, expected_amount, allocated_units, confidence, status, cas_transaction_id,
          transaction_date, transaction_amount, transaction_units, transaction_nav)
        values (${runId}, ${p.clientId}, ${ctx.sec.Y}, ${y.scheme_name}, '{}', 'INCREASE', 100, 14999.25, ${b.itemIds[0]}, 'ADVICE_MATCH',
          14999.25, 100, 'HIGH', 'SUGGESTED', ${row.cas_transaction_id}, '2026-10-12', 14999.25, 100, 149.99) returning id`)[0];
      await ctx.as("advisor", (t) => resolveMatch(t, ctx.users.advisor, am.id, "CONFIRM", { note: "Advised outside the dashboard" }));
      await ctx.tx`update public.reconciliation_matches set status = 'REJECTED', resolved_at = now(), reviewed_at = now(),
        resolution_note = ${`${RECORDED_AS_ADVISED} (call ${b.batchCode})`} where id = ${row.id}`;
      const before = (await progress(ctx, p.buyItem)).executed_amount;
      expect(before).toBeGreaterThanOrEqual(14999);

      const out = await ctx.as("admin", (t) => settleSipInstalments(t, ctx.users.admin, { clientId: p.clientId }));
      expect(out).toEqual({ reclassified: 1, callsCancelled: 1 });
      expect((await progress(ctx, p.buyItem)).executed_amount).toBe(before - 14999.25);
      expect((await ctx.tx<{ status: string }[]>`select status from public.advice_items where id = ${b.itemIds[0]}`)[0].status).toBe("CANCELLED");
      expect((await ctx.tx<{ status: string }[]>`select status from public.executions where advice_item_id = ${b.itemIds[0]}`).map((e) => e.status)).toEqual(["CANCELLED"]);
      expect((await ctx.tx<{ classification: string }[]>`select classification from public.reconciliation_matches where id = ${row.id}`)[0].classification).toBe("SIP_INSTALMENT");
      // Nothing left to do the second time.
      expect(await ctx.as("admin", (t) => settleSipInstalments(t, ctx.users.admin, { clientId: p.clientId }))).toEqual({ reclassified: 0, callsCancelled: 0 });
    });
  });

  it("a plain Purchase repeating every month is a SIP instalment, unless a Buy call on the fund is open", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx); // latest CAS 01-Sep
      const y = (await ctx.tx<{ scheme_name: string; isin: string }[]>`select scheme_name, isin from public.security_master where id = ${ctx.sec.Y}`)[0];
      const x = (await ctx.tx<{ scheme_name: string; isin: string }[]>`select scheme_name, isin from public.security_master where id = ${ctx.sec.X}`)[0];
      const buy = (date: string, bal: number) => ({ date, type: "PURCHASE" as const, description: "Purchase", scheme_name: y.scheme_name, isin: y.isin, folio_number: "77/0", amount: 5000, units: 50, nav: 100, balance_units: bal });
      const snap = await ctx.as("ops", async (t) => {
        const pr = parsed("2026-10-12", [{ security: ctx.sec.X, name: x.scheme_name, units: 10000, nav: 150 }, { security: ctx.sec.Y, name: y.scheme_name, units: 200, nav: 100 }],
          [buy("2026-07-05", 50), buy("2026-08-05", 100), buy("2026-09-05", 150), buy("2026-10-05", 200)]);
        pr.holdings[0].isin = x.isin;
        pr.holdings[1].isin = y.isin;
        const id = await createSnapshotFromParsed(t, { clientId: p.clientId, casDocumentId: null, parsed: pr, source: "CAS", createdBy: ctx.users.ops.id });
        await confirmSnapshot(t, id, "checked");
        return id;
      });
      const { runId } = await ctx.as("ops", (t) => runReconciliation(t, ctx.users.ops, { clientId: p.clientId, currentSnapshotId: snap }));
      const rows = await ctx.tx<{ classification: string }[]>`select classification from public.reconciliation_matches where run_id = ${runId} and status <> 'REJECTED'`;
      expect(rows.map((r) => r.classification)).toEqual(["SIP_INSTALMENT", "SIP_INSTALMENT"]);
    });
  });
});
