import { afterAll, describe, expect, it } from "vitest";
import { confirmSnapshot, createSnapshotFromParsed } from "@/services/portfolio";
import { issueAdvice } from "@/services/advice";
import { recordAdvisedOffline, runReconciliation } from "@/services/reconciliation";
import { clientWithActivePlan, parsed, progress, scenario, sql, TEST_DB } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});

describeDb("A CAS trade advised outside the dashboard", () => {
  it("records the call on the plan line and confirms the trade as its execution", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx); // plan: SELL X ₹10L, BUY Y ₹6L; X 10,000 units @150
      const x = (await ctx.tx<{ scheme_name: string; isin: string }[]>`select scheme_name, isin from public.security_master where id = ${ctx.sec.X}`)[0];
      const snap = await ctx.as("ops", async (t) => {
        const pr = parsed("2026-09-16", [{ security: ctx.sec.X, name: x.scheme_name, units: 8000, nav: 150 }], [
          { date: "2026-09-12", type: "REDEMPTION", scheme_name: x.scheme_name, isin: x.isin, folio_number: "T1", amount: -300000, units: -2000, nav: 150, balance_units: 8000 },
        ]);
        pr.holdings[0].isin = x.isin;
        const id = await createSnapshotFromParsed(t, { clientId: p.clientId, casDocumentId: null, parsed: pr, source: "CAS", createdBy: ctx.users.ops.id });
        await confirmSnapshot(t, id, "checked");
        return id;
      });
      const { runId } = await ctx.as("ops", (t) => runReconciliation(t, ctx.users.ops, { clientId: p.clientId, currentSnapshotId: snap }));
      const unadvised = (await ctx.tx<{ id: string }[]>`
        select id from public.reconciliation_matches where run_id = ${runId} and classification = 'UNADVISED'`)[0];
      expect(unadvised).toBeTruthy();

      // A call cannot be dated after the trade.
      await expect(ctx.as("advisor", (t) => recordAdvisedOffline(t, ctx.users.advisor, unadvised.id, {
        channel: "PHONE", communicatedAt: new Date("2026-09-13T10:00:00+05:30"),
      }))).rejects.toThrow(/on or before the trade/);

      const out = await ctx.as("advisor", (t) => recordAdvisedOffline(t, ctx.users.advisor, unadvised.id, { channel: "WHATSAPP", note: "advised on WhatsApp" }));
      expect(out.planItemId).toBe(p.sellItem);
      const ex = await ctx.tx<{ execution_date: string; executed_amount: number; verification_type: string }[]>`
        select execution_date::text, executed_amount::float8, verification_type from public.executions where advice_item_id = ${out.adviceItemId}`;
      expect(ex).toEqual([{ execution_date: "2026-09-12", executed_amount: 300000, verification_type: "CAS_VERIFIED" }]);
      expect((await progress(ctx, p.sellItem)).executed_amount).toBe(300000);
      const rows = await ctx.tx<{ classification: string; status: string }[]>`
        select classification, status from public.reconciliation_matches where run_id = ${runId} order by created_at, classification`;
      expect(rows).toEqual(expect.arrayContaining([
        { classification: "UNADVISED", status: "REJECTED" },
        { classification: "ADVICE_MATCH", status: "CONFIRMED" },
      ]));
      expect((await ctx.tx<{ status: string }[]>`select status from public.reconciliation_runs where id = ${runId}`)[0].status).not.toBe("OPEN");
      // Once recorded it cannot be recorded again.
      await expect(ctx.as("advisor", (t) => recordAdvisedOffline(t, ctx.users.advisor, unadvised.id, { channel: "PHONE" }))).rejects.toThrow(/Only an unadvised/);
    });
  });

  it("records only the part of a trade that open calls did not cover", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx);
      const x = (await ctx.tx<{ scheme_name: string; isin: string }[]>`select scheme_name, isin from public.security_master where id = ${ctx.sec.X}`)[0];
      await ctx.as("advisor", (t) => issueAdvice(t, ctx.users.advisor, {
        clientId: p.clientId, communicatedAt: new Date("2026-09-10T10:00:00+05:30"), channel: "PHONE",
        items: [{ plan_item_id: p.sellItem, security_id: ctx.sec.X, action: "SELL", quantity_basis: "AMOUNT", advised_amount: 100000 }],
      }));
      const snap = await ctx.as("ops", async (t) => {
        const pr = parsed("2026-09-16", [{ security: ctx.sec.X, name: x.scheme_name, units: 8000, nav: 150 }], [
          { date: "2026-09-12", type: "REDEMPTION", scheme_name: x.scheme_name, isin: x.isin, folio_number: "T1", amount: -300000, units: -2000, nav: 150, balance_units: 8000 },
        ]);
        pr.holdings[0].isin = x.isin;
        const id = await createSnapshotFromParsed(t, { clientId: p.clientId, casDocumentId: null, parsed: pr, source: "CAS", createdBy: ctx.users.ops.id });
        await confirmSnapshot(t, id, "checked");
        return id;
      });
      const { runId } = await ctx.as("ops", (t) => runReconciliation(t, ctx.users.ops, { clientId: p.clientId, currentSnapshotId: snap }));
      const rest = (await ctx.tx<{ id: string; approx_amount: number }[]>`
        select id, approx_amount::float8 from public.reconciliation_matches where run_id = ${runId} and classification = 'UNADVISED'`)[0];
      expect(rest.approx_amount).toBe(200000);
      const out = await ctx.as("advisor", (t) => recordAdvisedOffline(t, ctx.users.advisor, rest.id, { channel: "PHONE" }));
      const a = await ctx.tx<{ advised_amount: number; status: string }[]>`select advised_amount::float8, status from public.advice_items where id = ${out.adviceItemId}`;
      expect(a[0].advised_amount).toBe(200000);
      expect(a[0].status).toBe("EXECUTED");
      const pr = await progress(ctx, p.sellItem);
      expect(pr.advised_amount).toBe(300000);
      expect(pr.executed_amount).toBe(300000);
      expect(pr.pending_amount).toBe(0);
      const u = await ctx.tx<{ units: number }[]>`select coalesce(sum(executed_units), 0)::float8 as units from public.executions e join public.advice_items ai on ai.id = e.advice_item_id where ai.client_id = ${p.clientId}`;
      expect(Math.abs(u[0].units)).toBeCloseTo(2000, 2);
    });
  });
});
