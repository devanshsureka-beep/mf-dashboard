import { afterAll, describe, expect, it } from "vitest";
import { advisoryReportResultSchema } from "@/lib/integrations/contracts";
import { issueAdvice, linkCallsToPlan } from "@/services/advice";
import { approvePlan, ingestAdvisoryReport } from "@/services/plans";
import { confirmSnapshot, createSnapshotFromParsed } from "@/services/portfolio";
import { recordAdvisedOffline, runReconciliation } from "@/services/reconciliation";
import { clientWithActivePlan, parsed, scenario, sql, TEST_DB, type Ctx } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});

/** Replace the plan with: Migrate X (Regular) to Y (Direct). */
async function migratePlan(ctx: Ctx, clientId: string) {
  const names = await ctx.tx<{ id: string; scheme_name: string }[]>`select id, scheme_name from public.security_master where id in (${ctx.sec.X}, ${ctx.sec.Y})`;
  const nameOf = (id: string) => names.find((n) => n.id === id)!.scheme_name;
  const payload = advisoryReportResultSchema.parse({
    client_id: clientId, status: "PARSED",
    plan: { plan_name: "Migration only" },
    items: [{ action: "MIGRATE", scheme_name: nameOf(ctx.sec.X), target_amount: 1500000, current_amount: 1500000, switch_to_scheme_name: nameOf(ctx.sec.Y), reason: "MIGRATE TO DIRECT; Hold" }],
  });
  const ids = { [nameOf(ctx.sec.X).toLowerCase()]: ctx.sec.X, [nameOf(ctx.sec.Y).toLowerCase()]: ctx.sec.Y };
  const draft = await ctx.as("advisor", (t) => ingestAdvisoryReport(t, payload, ctx.users.advisor.id, { extractionSource: "IMPORT", securityIds: ids }));
  await ctx.as("advisor", (t) => approvePlan(t, ctx.users.advisor, draft.planId!, "migration plan"));
  const line = (await ctx.tx<{ id: string }[]>`select id from public.advisory_plan_items where plan_id = ${draft.planId!} and action = 'MIGRATE'`)[0];
  return { planId: draft.planId!, migrateLine: line.id };
}

async function extra(ctx: Ctx, clientId: string) {
  return (await ctx.as("advisor", (t) => t<Record<string, number>[]>`
    select migrate_target::float8, migrate_advised::float8, migrate_executed::float8, migrate_left::float8,
           migrate_buy_advised::float8, off_plan_sell_advised::float8, off_plan_buy_advised::float8
    from public.v_client_rebalance_extra where client_id = ${clientId}`))[0];
}

describeDb("Migrate to Direct done as redeem + buy", () => {
  it("links a CAS redemption recorded as advised to the Migrate line, and counts the Direct buy as its second leg", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx); // X 10,000 units @150
      const { migrateLine } = await migratePlan(ctx, p.clientId);
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
      const out = await ctx.as("advisor", (t) => recordAdvisedOffline(t, ctx.users.advisor, unadvised.id, { channel: "PHONE" }));
      expect(out.planItemId).toBe(migrateLine);

      // The Direct buy of the same fund, issued without a plan line.
      await ctx.as("advisor", (t) => issueAdvice(t, ctx.users.advisor, {
        clientId: p.clientId, communicatedAt: new Date("2026-09-17T10:00:00+05:30"), channel: "PHONE",
        items: [{ security_id: ctx.sec.Y, action: "BUY", quantity_basis: "AMOUNT", advised_amount: 300000 }],
      }));
      expect(await extra(ctx, p.clientId)).toEqual({
        migrate_target: 1500000, migrate_advised: 300000, migrate_executed: 300000, migrate_left: 1200000,
        migrate_buy_advised: 300000, off_plan_sell_advised: 0, off_plan_buy_advised: 0,
      });
    });
  });

  it("lets an admin link earlier calls outside the plan to the plan line of the same fund", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx);
      const { migrateLine } = await migratePlan(ctx, p.clientId);
      const call = await ctx.as("advisor", (t) => issueAdvice(t, ctx.users.advisor, {
        clientId: p.clientId, communicatedAt: new Date("2026-09-17T10:00:00+05:30"), channel: "PHONE",
        items: [
          { security_id: ctx.sec.X, action: "SELL", quantity_basis: "AMOUNT", advised_amount: 200000 },
          { security_id: ctx.sec.Z, action: "BUY", quantity_basis: "AMOUNT", advised_amount: 50000 },
        ],
      }));
      expect(await extra(ctx, p.clientId)).toMatchObject({ migrate_advised: 0, off_plan_sell_advised: 200000, off_plan_buy_advised: 50000 });

      await expect(ctx.as("advisor", (t) => linkCallsToPlan(t, ctx.users.advisor, p.clientId))).rejects.toThrow(/Only an admin/);
      const r = await ctx.as("admin", (t) => linkCallsToPlan(t, ctx.users.admin, p.clientId));
      expect(r).toEqual({ linked: 1, left: 1 });
      const linked = await ctx.tx<{ plan_item_id: string | null }[]>`select plan_item_id from public.advice_items where id = ${call.itemIds[0]}`;
      expect(linked[0].plan_item_id).toBe(migrateLine);
      expect(await extra(ctx, p.clientId)).toMatchObject({ migrate_advised: 200000, off_plan_sell_advised: 0, off_plan_buy_advised: 50000 });
    });
  });
});
