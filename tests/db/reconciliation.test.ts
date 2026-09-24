import { afterAll, describe, expect, it } from "vitest";
import { issueAdvice } from "@/services/advice";
import { recordExecution } from "@/services/executions";
import { confirmSnapshot, createSnapshotFromParsed, registerCasDocument } from "@/services/portfolio";
import { resolveMatch, runReconciliation } from "@/services/reconciliation";
import { clientWithActivePlan, parsed, progress, scenario, sql, TEST_DB, type Ctx } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});

async function names(ctx: Ctx) {
  const rows = await ctx.tx<{ id: string; scheme_name: string; isin: string }[]>`select id, scheme_name, isin from public.security_master where id in (${ctx.sec.X}, ${ctx.sec.Y}, ${ctx.sec.Z})`;
  return (id: string) => rows.find((r) => r.id === id)!;
}

describeDb("CAS reconciliation against the database", () => {
  it("matches, verifies without double counting, and flags unadvised activity", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx);  // baseline: 10,000 units of X @150
      const n = await names(ctx);
      // SELL 4,000 units of X (unit call) + BUY ₹1,00,000 of Y already confirmed by the client.
      const b = await ctx.as("advisor", (t) => issueAdvice(t, ctx.users.advisor, {
        clientId: p.clientId, communicatedAt: new Date("2026-09-05T10:00:00+05:30"), channel: "PHONE",
        items: [
          { plan_item_id: p.sellItem, security_id: ctx.sec.X, action: "SELL", quantity_basis: "UNITS", advised_amount: 600000, advised_units: 4000, reference_price: 150 },
          { plan_item_id: p.buyItem, security_id: ctx.sec.Y, action: "BUY", quantity_basis: "AMOUNT", advised_amount: 100000 },
        ],
      }));
      await ctx.as("ops", (t) => recordExecution(t, ctx.users.ops, {
        adviceItemId: b.itemIds[1], executionDate: "2026-09-06", executedAmount: 100000, verificationType: "CLIENT_CONFIRMED",
      }));

      // New CAS: X 6,000 units (−4,000 advised), Y 1,000 units @100 (bought), Z 500 units (no advice => unadvised).
      const snap = await ctx.as("ops", async (t) => {
        const pr = parsed("2026-09-20", [
          { security: ctx.sec.X, name: n(ctx.sec.X).scheme_name, units: 6000, nav: 150 },
          { security: ctx.sec.Y, name: n(ctx.sec.Y).scheme_name, units: 1000, nav: 100 },
          { security: ctx.sec.Z, name: n(ctx.sec.Z).scheme_name, units: 500, nav: 20 },
        ]);
        pr.holdings.forEach((h, i) => { h.isin = n([ctx.sec.X, ctx.sec.Y, ctx.sec.Z][i]).isin; });
        const id = await createSnapshotFromParsed(t, { clientId: p.clientId, casDocumentId: null, parsed: pr, source: "CAS", createdBy: ctx.users.ops.id });
        const c = await confirmSnapshot(t, id, "checked");
        expect(c.previousSnapshotId).toBe(p.snapshotId);
        return id;
      });

      const { runId } = await ctx.as("ops", (t) => runReconciliation(t, ctx.users.ops, { clientId: p.clientId, currentSnapshotId: snap }));
      const matches = await ctx.tx<{ id: string; security_id: string; classification: string; confidence: string; status: string; advice_item_id: string | null }[]>`
        select id, security_id, classification, confidence, status, advice_item_id from public.reconciliation_matches where run_id = ${runId}`;
      const byS = (s: string) => matches.find((m) => m.security_id === s)!;
      expect(byS(ctx.sec.X)).toMatchObject({ classification: "ADVICE_MATCH", confidence: "HIGH", status: "SUGGESTED", advice_item_id: b.itemIds[0] });
      expect(byS(ctx.sec.Y)).toMatchObject({ classification: "ADVICE_MATCH", advice_item_id: b.itemIds[1] });
      expect(byS(ctx.sec.Z)).toMatchObject({ classification: "UNADVISED", status: "UNEXPLAINED" });

      // Nothing executed yet for X: suggestions are not executions (RULE 6).
      expect((await progress(ctx, p.sellItem)).executed_amount).toBe(0);

      // Confirm X -> creates a CAS_VERIFIED execution.
      const rx = await ctx.as("ops", (t) => resolveMatch(t, ctx.users.ops, byS(ctx.sec.X).id, "CONFIRM"));
      expect(rx.executionId).toBeTruthy();
      expect((await progress(ctx, p.sellItem)).executed_amount).toBe(600000);

      // Confirm Y -> verifies the client-confirmed execution, creates nothing new.
      const ry = await ctx.as("ops", (t) => resolveMatch(t, ctx.users.ops, byS(ctx.sec.Y).id, "CONFIRM"));
      expect(ry).toEqual({ executionId: null, verifiedExecutions: 1 });
      const buyExecs = await ctx.tx<{ n: number; total: number }[]>`
        select count(*)::int as n, sum(executed_amount) as total from public.executions where advice_item_id = ${b.itemIds[1]}`;
      expect(buyExecs[0]).toEqual({ n: 1, total: 100000 });

      // Run stays OPEN until the unadvised change is acknowledged.
      let run = await ctx.tx<{ status: string }[]>`select status from public.reconciliation_runs where id = ${runId}`;
      expect(run[0].status).toBe("OPEN");
      const unadvisedCount = await ctx.as("ops", (t) => t<{ unadvised_count: number }[]>`select unadvised_count from public.v_client_summary where client_id = ${p.clientId}`);
      expect(unadvisedCount[0].unadvised_count).toBe(1);
      await ctx.as("ops", (t) => resolveMatch(t, ctx.users.ops, byS(ctx.sec.Z).id, "ACKNOWLEDGE", { note: "Client bought on their own" }));
      run = await ctx.tx`select status from public.reconciliation_runs where id = ${runId}`;
      expect(run[0].status).toBe("COMPLETED");

      // Confirmed matches cannot be re-decided; a second run for the same pair is not created.
      expect(await ctx.expectError("ops", (t) => resolveMatch(t, ctx.users.ops, byS(ctx.sec.X).id, "REJECT", { note: "x" }))).toMatch(/already CONFIRMED/);
      const again = await ctx.as("ops", (t) => runReconciliation(t, ctx.users.ops, { clientId: p.clientId, currentSnapshotId: snap }));
      expect(again).toEqual({ runId, existing: true });
    });
  });

  it("snapshots are immutable after confirmation and duplicate CAS files are rejected", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx);
      expect(await ctx.expectError("advisor", (t) => t`update public.portfolio_holdings set units = 1 where snapshot_id = ${p.snapshotId}`)).toMatch(/immutable/);
      expect(await ctx.expectError("advisor", (t) => t`update public.portfolio_snapshots set total_current_value = 1 where id = ${p.snapshotId}`)).toMatch(/immutable/);
      const doc = { clientId: p.clientId, fileName: "cas.pdf", mimeType: "application/pdf", sizeBytes: 10, sha256: "c".repeat(64), filePath: `${p.clientId}/CAS/x.pdf`, source: "CAMS", passwordProtected: true };
      await ctx.as("ops", (t) => registerCasDocument(t, ctx.users.ops.id, doc));
      expect(await ctx.expectError("ops", (t) => registerCasDocument(t, ctx.users.ops.id, doc))).toMatch(/already been uploaded/);
    });
  });
});
