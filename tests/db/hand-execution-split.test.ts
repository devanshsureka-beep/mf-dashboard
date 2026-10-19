import { afterAll, describe, expect, it } from "vitest";
import { issueAdvice } from "@/services/advice";
import { recordExecution } from "@/services/executions";
import { confirmSnapshot, createSnapshotFromParsed } from "@/services/portfolio";
import { runReconciliation } from "@/services/reconciliation";
import { clientWithActivePlan, parsed, scenario, sql, TEST_DB, type Ctx } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});

async function xFund(ctx: Ctx) {
  return (await ctx.tx<{ scheme_name: string; isin: string }[]>`select scheme_name, isin from public.security_master where id = ${ctx.sec.X}`)[0];
}

/** A CAS 15 days after the call with the given X redemptions (units @150), X held at 10,000 less what was sold. */
async function casWith(ctx: Ctx, clientId: string, amounts: number[]) {
  const x = await xFund(ctx);
  const units = amounts.map((a) => Math.round((a / 150) * 1000) / 1000);
  const sold = units.reduce((t, u) => t + u, 0);
  return ctx.as("ops", async (t) => {
    let bal = 10000;
    const pr = parsed("2026-09-25", [{ security: ctx.sec.X, name: x.scheme_name, units: Math.round((10000 - sold) * 1000) / 1000, nav: 150 }],
      amounts.map((a, i) => {
        bal = Math.round((bal - units[i]) * 1000) / 1000;
        return { date: `2026-09-${11 + i}`, type: "REDEMPTION", scheme_name: x.scheme_name, isin: x.isin, folio_number: "T1", amount: -a, units: -units[i], nav: 150, balance_units: bal };
      }));
    pr.holdings[0].isin = x.isin;
    const id = await createSnapshotFromParsed(t, { clientId, casDocumentId: null, parsed: pr, source: "CAS", createdBy: ctx.users.ops.id });
    await confirmSnapshot(t, id, "checked");
    return id;
  });
}

async function sellCall(ctx: Ctx, p: Awaited<ReturnType<typeof clientWithActivePlan>>, amount: number) {
  return ctx.as("advisor", (t) => issueAdvice(t, ctx.users.advisor, {
    clientId: p.clientId, communicatedAt: new Date("2026-09-10T10:00:00+05:30"), channel: "PHONE",
    items: [{ plan_item_id: p.sellItem, security_id: ctx.sec.X, action: "SELL", quantity_basis: "AMOUNT", advised_amount: amount }],
  }));
}

describeDb("A hand-recorded execution that the CAS shows as several trades", () => {
  it("is verified by the trades together, never counted twice", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx);
      const b = await sellCall(ctx, p, 200000);
      await ctx.as("ops", (t) => recordExecution(t, ctx.users.ops, {
        adviceItemId: b.itemIds[0], executionDate: "2026-09-11", executedAmount: 100000, verificationType: "CLIENT_CONFIRMED",
      }));
      // The client actually sold ₹1L, in two redemptions of ₹50k.
      const snap = await casWith(ctx, p.clientId, [50000, 50000]);
      await ctx.as("ops", (t) => runReconciliation(t, ctx.users.ops, { clientId: p.clientId, currentSnapshotId: snap }));

      const ex = (await ctx.tx<{ n: number; total: number; verified: number }[]>`
        select count(*)::int as n, coalesce(sum(executed_amount), 0)::float8 as total, count(cas_verified_at)::int as verified
        from public.executions where advice_item_id = ${b.itemIds[0]} and status in ('EXECUTED', 'PARTIAL')`)[0];
      expect(ex).toEqual({ n: 1, total: 100000, verified: 1 });
      const call = (await ctx.tx<{ status: string; executed_amount: number }[]>`
        select status, executed_amount::float8 from public.v_advice_items where id = ${b.itemIds[0]}`)[0];
      expect(call).toEqual({ status: "PARTIALLY_EXECUTED", executed_amount: 100000 });
    });
  });

  it("a call fully recorded by hand, then split in the CAS, does not fail the upload", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx);
      const b = await sellCall(ctx, p, 100000);
      await ctx.as("ops", (t) => recordExecution(t, ctx.users.ops, {
        adviceItemId: b.itemIds[0], executionDate: "2026-09-11", executedAmount: 100000, verificationType: "CLIENT_CONFIRMED",
      }));
      const snap = await casWith(ctx, p.clientId, [50000, 50000]);
      await ctx.as("ops", (t) => runReconciliation(t, ctx.users.ops, { clientId: p.clientId, currentSnapshotId: snap }));

      const ex = (await ctx.tx<{ n: number; total: number; verified: number }[]>`
        select count(*)::int as n, coalesce(sum(executed_amount), 0)::float8 as total, count(cas_verified_at)::int as verified
        from public.executions where advice_item_id = ${b.itemIds[0]} and status in ('EXECUTED', 'PARTIAL')`)[0];
      expect(ex).toEqual({ n: 1, total: 100000, verified: 1 });
    });
  });
});
