import { afterAll, describe, expect, it } from "vitest";
import { advisoryReportResultSchema } from "@/lib/integrations/contracts";
import { recordExecution } from "@/services/executions";
import { getMigrations, issueMigrationCalls } from "@/services/migrations";
import { approvePlan, ingestAdvisoryReport } from "@/services/plans";
import { clientWithActivePlan, scenario, sql, TEST_DB } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});

describeDb("Migrate to Direct checklist", () => {
  it("is a plan line outside the sell/buy targets, executed through a switch call", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx); // holds X (10,000 units)
      const names = await ctx.tx<{ id: string; scheme_name: string }[]>`select id, scheme_name from public.security_master where id in (${ctx.sec.X}, ${ctx.sec.Y})`;
      const nameOf = (id: string) => names.find((n) => n.id === id)!.scheme_name;
      const payload = advisoryReportResultSchema.parse({
        client_id: p.clientId, status: "PARSED",
        plan: { plan_name: "Rebalancing with migration" },
        items: [
          { action: "MIGRATE", scheme_name: nameOf(ctx.sec.X), target_amount: 1500000, current_amount: 1500000, switch_to_scheme_name: nameOf(ctx.sec.Y), reason: "MIGRATE TO DIRECT; Hold" },
          { action: "BUY", scheme_name: nameOf(ctx.sec.Y), target_amount: 100000 },
        ],
      });
      const ids = { [nameOf(ctx.sec.X).toLowerCase()]: ctx.sec.X, [nameOf(ctx.sec.Y).toLowerCase()]: ctx.sec.Y };
      const draft = await ctx.as("advisor", (t) => ingestAdvisoryReport(t, payload, ctx.users.advisor.id, { extractionSource: "IMPORT", securityIds: ids }));
      await ctx.as("advisor", (t) => approvePlan(t, ctx.users.advisor, draft.planId!, "replace with migration plan"));
      const planId = draft.planId!;

      // Not in the lump-sum targets.
      const t = (await ctx.tx<{ sell_target: number; buy_target: number }[]>`
        select sell_target::float8, buy_target::float8 from public.v_plan_transition where plan_id = ${planId}`)[0];
      expect(t).toEqual({ sell_target: 0, buy_target: 100000 });

      let m = await ctx.as("advisor", (tx) => getMigrations(tx, planId));
      expect(m).toHaveLength(1);
      expect(m[0]).toMatchObject({ migration_status: "TO_DO", switch_to_security_id: ctx.sec.Y, regular_units_now: 10000 });

      const r = await ctx.as("advisor", (tx) => issueMigrationCalls(tx, ctx.users.advisor, {
        clientId: p.clientId, planId, planItemIds: [m[0].plan_item_id], channel: "PHONE", communicatedAt: new Date("2026-09-30T11:00:00+05:30"),
      }));
      expect(r.count).toBe(1);
      const call = (await ctx.tx<{ id: string; action: string; quantity_basis: string; advised_units: number }[]>`
        select id, action, quantity_basis, advised_units::float8 from public.advice_items where plan_item_id = ${m[0].plan_item_id}`)[0];
      expect(call).toMatchObject({ action: "SWITCH", quantity_basis: "UNITS", advised_units: 10000 });
      m = await ctx.as("advisor", (tx) => getMigrations(tx, planId));
      expect(m[0].migration_status).toBe("CALL_ISSUED");
      // Issuing again does nothing for a line that already has a call.
      await expect(ctx.as("advisor", (tx) => issueMigrationCalls(tx, ctx.users.advisor, {
        clientId: p.clientId, planId, planItemIds: [m[0].plan_item_id], channel: "PHONE", communicatedAt: new Date("2026-09-30T11:00:00+05:30"),
      }))).rejects.toThrow(/already have a call/);

      await ctx.as("ops", (tx) => recordExecution(tx, ctx.users.ops, { adviceItemId: call.id, executionDate: "2026-09-30", executedAmount: 1510000, executedUnits: 10000, verificationType: "CLIENT_CONFIRMED" }));
      m = await ctx.as("advisor", (tx) => getMigrations(tx, planId));
      expect(m[0].migration_status).toBe("DONE");
      // A switch moves money fund to fund: money left is unchanged.
      const cash = await ctx.tx<{ money_left: number }[]>`select money_left::float8 from public.v_client_summary where client_id = ${p.clientId}`;
      expect(cash[0].money_left).toBe(0);
    });
  });
});
