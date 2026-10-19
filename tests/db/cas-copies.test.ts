import { afterAll, describe, expect, it } from "vitest";
import { issueAdvice } from "@/services/advice";
import { confirmSnapshot, createSnapshotFromParsed, rejectSnapshot } from "@/services/portfolio";
import { runReconciliation } from "@/services/reconciliation";
import { clientWithActivePlan, parsed, progress, scenario, sql, TEST_DB } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});

describeDb("A second copy of the same CAS", () => {
  it("keeps its transactions when the first copy was rejected, so its calls still match", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx); // SELL X ₹10L; X 10,000 units @150 on 01-Sep
      const x = (await ctx.tx<{ scheme_name: string; isin: string }[]>`select scheme_name, isin from public.security_master where id = ${ctx.sec.X}`)[0];
      await ctx.as("advisor", (t) => issueAdvice(t, ctx.users.advisor, {
        clientId: p.clientId, communicatedAt: new Date("2026-09-10T10:00:00+05:30"), channel: "PHONE",
        items: [{ plan_item_id: p.sellItem, security_id: ctx.sec.X, action: "SELL", quantity_basis: "AMOUNT", advised_amount: 300000 }],
      }));
      const cas = () => {
        const pr = parsed("2026-09-16", [{ security: ctx.sec.X, name: x.scheme_name, units: 8000, nav: 150 }], [
          { date: "2026-09-12", type: "REDEMPTION", scheme_name: x.scheme_name, isin: x.isin, folio_number: "T1", amount: -300000, units: -2000, nav: 150, balance_units: 8000 },
        ]);
        pr.holdings[0].isin = x.isin;
        return pr;
      };
      // First copy: read, then rejected (e.g. a reader problem).
      const a = await ctx.as("ops", (t) => createSnapshotFromParsed(t, { clientId: p.clientId, casDocumentId: null, parsed: cas(), source: "CAS", createdBy: ctx.users.ops.id }));
      await ctx.as("ops", (t) => rejectSnapshot(t, a, "wrong reading"));
      const visible = async () => (await ctx.as("advisor", (t) => t<{ n: number }[]>`select count(*)::int as n from public.v_cas_transactions where client_id = ${p.clientId}`))[0].n;
      expect(await visible()).toBe(0); // only a rejected copy read it

      // Second copy of the same statement: it has the trade too, and the call is matched by it.
      const b = await ctx.as("ops", async (t) => {
        const id = await createSnapshotFromParsed(t, { clientId: p.clientId, casDocumentId: null, parsed: cas(), source: "CAS", createdBy: ctx.users.ops.id });
        await confirmSnapshot(t, id, "checked");
        return id;
      });
      expect(await visible()).toBe(1);
      const { runId } = await ctx.as("ops", (t) => runReconciliation(t, ctx.users.ops, { clientId: p.clientId, currentSnapshotId: b }));
      const run = (await ctx.tx<{ engine_version: string }[]>`select engine_version from public.reconciliation_runs where id = ${runId}`)[0];
      expect(run.engine_version).toBe("v2-transactions");
      expect(Number((await progress(ctx, p.sellItem)).executed_amount)).toBe(300000);
    });
  });
});
