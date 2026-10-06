import { afterAll, describe, expect, it } from "vitest";
import { issueAdvice } from "@/services/advice";
import { confirmSnapshot, createSnapshotFromParsed } from "@/services/portfolio";
import { recheckRun, runReconciliation } from "@/services/reconciliation";
import { clientWithActivePlan, parsed, progress, scenario, sql, TEST_DB } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});

describeDb("A newer CAS updates the client's plan", () => {
  it("a redemption stored as 'less STT' matches the SELL call; re-check adds trades the run has not seen", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx); // SELL X ₹10L, BUY Y ₹6L
      const x = (await ctx.tx<{ scheme_name: string; isin: string }[]>`select scheme_name, isin from public.security_master where id = ${ctx.sec.X}`)[0];
      await ctx.as("advisor", (t) => issueAdvice(t, ctx.users.advisor, {
        clientId: p.clientId, communicatedAt: new Date("2026-09-10T10:00:00+05:30"), channel: "PHONE",
        items: [{ plan_item_id: p.sellItem, security_id: ctx.sec.X, action: "SELL", quantity_basis: "AMOUNT", advised_amount: 300000 }],
      }));
      // As an older reader stored it: the redemption typed as a tax line.
      const snap = await ctx.as("ops", async (t) => {
        const pr = parsed("2026-09-16", [{ security: ctx.sec.X, name: x.scheme_name, units: 8000, nav: 150 }], [
          { date: "2026-09-12", type: "STT", description: "*Redemption - NEFT/RTGS PAYOUT-BSE - , less STT", scheme_name: x.scheme_name, isin: x.isin, folio_number: "T1", amount: -300000, units: -2000, nav: 150, balance_units: 8000 },
          { date: "2026-09-12", type: "STT", description: "*** STT Paid ***", scheme_name: x.scheme_name, isin: x.isin, folio_number: "T1", amount: 3, units: null, nav: null, balance_units: null },
        ]);
        pr.holdings[0].isin = x.isin;
        const id = await createSnapshotFromParsed(t, { clientId: p.clientId, casDocumentId: null, parsed: pr, source: "CAS", createdBy: ctx.users.ops.id });
        await confirmSnapshot(t, id, "checked");
        return id;
      });
      const { runId } = await ctx.as("ops", (t) => runReconciliation(t, ctx.users.ops, { clientId: p.clientId, currentSnapshotId: snap }));
      const rows = await ctx.tx<{ classification: string; status: string }[]>`select classification, status from public.reconciliation_matches where run_id = ${runId}`;
      expect(rows).toEqual([{ classification: "ADVICE_MATCH", status: "CONFIRMED" }]);
      expect((await progress(ctx, p.sellItem)).executed_amount).toBe(300000);

      // Nothing new to match.
      expect(await ctx.as("ops", (t) => recheckRun(t, ctx.users.ops, runId))).toEqual({ added: 0, needsReview: 0, closedHistory: 0 });

      // A trade of this CAS the run has no row for (e.g. not recognised before) is picked up.
      await ctx.asSuper((t) => t`
        insert into public.portfolio_transactions (client_id, source_snapshot_id, security_id, transaction_date, transaction_type,
          scheme_name, isin, folio_number, units, nav, amount, description, dedupe_hash)
        values (${p.clientId}, ${snap}, ${ctx.sec.X}, '2026-09-14', 'OTHER', ${x.scheme_name}, ${x.isin}, 'T1', -100, 150, -15000,
                'Payment - Units Extinguished', 'test-recheck-1')`);
      expect(await ctx.as("ops", (t) => recheckRun(t, ctx.users.ops, runId))).toEqual({ added: 1, needsReview: 1, closedHistory: 0 });
      const run = await ctx.tx<{ status: string }[]>`select status from public.reconciliation_runs where id = ${runId}`;
      expect(run[0].status).toBe("OPEN");
      const added = await ctx.tx<{ classification: string; approx_amount: number; change_type: string }[]>`
        select classification, approx_amount::float8, change_type from public.reconciliation_matches
        where run_id = ${runId} and transaction_date = '2026-09-14'`;
      expect(added).toEqual([{ classification: "UNADVISED", approx_amount: 15000, change_type: "DECREASE" }]);
    });
  });

  it("a full-history CAS: trades dated on or before the previous CAS are history, not unadvised changes", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx); // previous CAS dated 2026-09-01
      const x = (await ctx.tx<{ scheme_name: string; isin: string }[]>`select scheme_name, isin from public.security_master where id = ${ctx.sec.X}`)[0];
      const snap = await ctx.as("ops", async (t) => {
        const pr = parsed("2026-10-01", [{ security: ctx.sec.X, name: x.scheme_name, units: 9000, nav: 150 }], [
          { date: "2021-03-10", type: "PURCHASE", scheme_name: x.scheme_name, isin: x.isin, folio_number: "T1", amount: 500000, units: 5000, nav: 100, balance_units: 5000 },
          { date: "2026-09-01", type: "SIP", scheme_name: x.scheme_name, isin: x.isin, folio_number: "T1", amount: 5000, units: 40, nav: 125, balance_units: 10000 },
          { date: "2026-09-20", type: "REDEMPTION", scheme_name: x.scheme_name, isin: x.isin, folio_number: "T1", amount: -150000, units: -1000, nav: 150, balance_units: 9000 },
        ]);
        pr.holdings[0].isin = x.isin;
        const id = await createSnapshotFromParsed(t, { clientId: p.clientId, casDocumentId: null, parsed: pr, source: "CAS", createdBy: ctx.users.ops.id });
        await confirmSnapshot(t, id, "checked");
        return id;
      });
      const { runId } = await ctx.as("ops", (t) => runReconciliation(t, ctx.users.ops, { clientId: p.clientId, currentSnapshotId: snap }));
      const rows = await ctx.tx<{ transaction_date: string; classification: string }[]>`
        select transaction_date::text, classification from public.reconciliation_matches where run_id = ${runId}`;
      expect(rows).toEqual([{ transaction_date: "2026-09-20", classification: "UNADVISED" }]);

      // A run made by the older engine (rows for history) is cleaned by re-check.
      await ctx.asSuper((t) => t`
        insert into public.reconciliation_matches (run_id, client_id, security_id, scheme_name, change_type, classification, detected_change,
          approx_amount, confidence, status, system_note, cas_transaction_id, transaction_date, transaction_amount, transaction_units)
        select ${runId}, ${p.clientId}, ${ctx.sec.X}, ${x.scheme_name}, 'INCREASE', 'UNADVISED', 5000, 500000, 'NONE', 'UNEXPLAINED', 'old',
               t.id, t.transaction_date, 500000, 5000
        from public.portfolio_transactions t where t.source_snapshot_id = ${snap} and t.transaction_date = '2021-03-10'`);
      expect(await ctx.as("ops", (t) => recheckRun(t, ctx.users.ops, runId))).toEqual({ added: 0, needsReview: 0, closedHistory: 1 });
    });
  });

  it("re-check never gives a call more than it advised (a match awaiting a decision counts as taken)", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx);
      const x = (await ctx.tx<{ scheme_name: string; isin: string }[]>`select scheme_name, isin from public.security_master where id = ${ctx.sec.X}`)[0];
      const call = await ctx.as("advisor", (t) => issueAdvice(t, ctx.users.advisor, {
        clientId: p.clientId, communicatedAt: new Date("2026-08-01T10:00:00+05:30"), channel: "PHONE",
        items: [{ plan_item_id: p.sellItem, security_id: ctx.sec.X, action: "SELL", quantity_basis: "AMOUNT", advised_amount: 300000 }],
      }));
      const snap = await ctx.as("ops", async (t) => {
        const pr = parsed("2026-09-20", [{ security: ctx.sec.X, name: x.scheme_name, units: 6000, nav: 150 }], [
          { date: "2026-09-05", type: "REDEMPTION", scheme_name: x.scheme_name, isin: x.isin, folio_number: "T1", amount: -300000, units: -2000, nav: 150, balance_units: 8000 },
        ]);
        pr.holdings[0].isin = x.isin;
        const id = await createSnapshotFromParsed(t, { clientId: p.clientId, casDocumentId: null, parsed: pr, source: "CAS", createdBy: ctx.users.ops.id });
        await confirmSnapshot(t, id, "checked");
        return id;
      });
      const { runId } = await ctx.as("ops", (t) => runReconciliation(t, ctx.users.ops, { clientId: p.clientId, currentSnapshotId: snap }));
      // More than 30 days after the call: proposed, not auto-confirmed.
      expect((await ctx.tx<{ status: string }[]>`select status from public.reconciliation_matches where run_id = ${runId}`).map((r) => r.status)).toEqual(["SUGGESTED"]);
      await ctx.asSuper((t) => t`
        insert into public.portfolio_transactions (client_id, source_snapshot_id, security_id, transaction_date, transaction_type,
          scheme_name, isin, folio_number, units, nav, amount, description, dedupe_hash)
        values (${p.clientId}, ${snap}, ${ctx.sec.X}, '2026-09-06', 'STT', ${x.scheme_name}, ${x.isin}, 'T1', -2000, 150, -300000,
                'Redemption less STT', 'test-recheck-double')`);
      await ctx.as("ops", (t) => recheckRun(t, ctx.users.ops, runId));
      const rows = await ctx.tx<{ classification: string; advice_item_id: string | null }[]>`
        select classification, advice_item_id from public.reconciliation_matches where run_id = ${runId} and transaction_date = '2026-09-06'`;
      expect(rows).toEqual([{ classification: "UNADVISED", advice_item_id: null }]);
      expect(call.itemIds).toHaveLength(1);
    });
  });
});
