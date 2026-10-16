import { afterAll, describe, expect, it } from "vitest";
import { closeAdvice, issueAdvice } from "@/services/advice";
import { confirmSnapshot, createSnapshotFromParsed } from "@/services/portfolio";
import { resolveMatch, runReconciliation } from "@/services/reconciliation";
import { clientWithActivePlan, parsed, progress, scenario, sql, TEST_DB } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});

describeDb("CAS matches on calls that were closed", () => {
  it("cancelling a call turns down its pending CAS match; nothing can be confirmed on it", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx); // 10,000 units of X @150
      const x = (await ctx.tx<{ scheme_name: string; isin: string }[]>`select scheme_name, isin from public.security_master where id = ${ctx.sec.X}`)[0];
      const b = await ctx.as("advisor", (t) => issueAdvice(t, ctx.users.advisor, {
        clientId: p.clientId, communicatedAt: new Date("2026-09-05T10:00:00+05:30"), channel: "PHONE",
        items: [{ plan_item_id: p.sellItem, security_id: ctx.sec.X, action: "SELL", quantity_basis: "UNITS", advised_amount: 600000, advised_units: 4000, reference_price: 150 }],
      }));
      const snap = await ctx.as("ops", async (t) => {
        const pr = parsed("2026-09-20", [{ security: ctx.sec.X, name: x.scheme_name, units: 6000, nav: 150 }]);
        pr.holdings[0].isin = x.isin;
        const id = await createSnapshotFromParsed(t, { clientId: p.clientId, casDocumentId: null, parsed: pr, source: "CAS", createdBy: ctx.users.ops.id });
        await confirmSnapshot(t, id, "checked");
        return id;
      });
      const { runId } = await ctx.as("ops", (t) => runReconciliation(t, ctx.users.ops, { clientId: p.clientId, currentSnapshotId: snap }));
      const match = (await ctx.tx<{ id: string; status: string }[]>`
        select id, status from public.reconciliation_matches where run_id = ${runId} and advice_item_id = ${b.itemIds[0]}`)[0];
      expect(match.status).toBe("SUGGESTED");

      await ctx.as("advisor", (t) => closeAdvice(t, b.itemIds[0], "CANCELLED", "client changed their mind"));
      const after = (await ctx.tx<{ status: string; resolution_note: string }[]>`
        select status, resolution_note from public.reconciliation_matches where id = ${match.id}`)[0];
      expect(after).toMatchObject({ status: "REJECTED", resolution_note: "The call was cancelled" });
      await expect(ctx.as("ops", (t) => resolveMatch(t, ctx.users.ops, match.id, "CONFIRM"))).rejects.toThrow(/already REJECTED/);
      // Nothing was executed on the cancelled call, and the run has nothing left to decide.
      expect((await progress(ctx, p.sellItem)).executed_amount).toBe(0);
      const run = (await ctx.tx<{ status: string }[]>`select status from public.reconciliation_runs where id = ${runId}`)[0];
      expect(run.status).toBe("COMPLETED");
    });
  });
});
