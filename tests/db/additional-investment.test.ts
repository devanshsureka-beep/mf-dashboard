import { afterAll, describe, expect, it } from "vitest";
import { advisoryReportResultSchema } from "@/lib/integrations/contracts";
import { approvePlan, closePlan, ingestAdvisoryReport } from "@/services/plans";
import { clientWithActivePlan, scenario, sql, TEST_DB, type Ctx } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});

async function additionalDraft(ctx: Ctx, clientId: string) {
  const names = await ctx.tx<{ id: string; scheme_name: string }[]>`select id, scheme_name from public.security_master where id in (${ctx.sec.X}, ${ctx.sec.Y})`;
  const nameOf = (id: string) => names.find((n) => n.id === id)!.scheme_name;
  const payload = advisoryReportResultSchema.parse({
    client_id: clientId, status: "PARSED",
    plan: { plan_name: "Additional investment · 2026-10-02", plan_date: "2026-10-02", plan_kind: "ADDITIONAL", fresh_money: 1500000 },
    items: [
      { action: "BUY", scheme_name: nameOf(ctx.sec.Y), target_amount: 1000000 },
      { action: "BUY", scheme_name: nameOf(ctx.sec.X), target_amount: 500000 },
    ],
    sip_items: [{ action: "START", scheme_name: nameOf(ctx.sec.Y), new_amount: 25000 }],
  });
  const securityIds = { [nameOf(ctx.sec.Y).toLowerCase()]: ctx.sec.Y, [nameOf(ctx.sec.X).toLowerCase()]: ctx.sec.X };
  const r = await ctx.as("advisor", (t) => ingestAdvisoryReport(t, payload, ctx.users.advisor.id, { extractionSource: "IMPORT", securityIds }));
  return r.planId!;
}

describeDb("Additional investment (fresh money on top of the active plan)", () => {
  it("is added to the active plan as a tranche: old plan and its numbers stay, fresh money counts in money left", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx); // active plan: SELL X 10L, BUY Y 6L
      const draftId = await additionalDraft(ctx, p.clientId);
      expect((await ctx.tx<{ plan_kind: string; fresh_money: number }[]>`select plan_kind, fresh_money::float8 from public.advisory_plans where id = ${draftId}`)[0])
        .toEqual({ plan_kind: "ADDITIONAL", fresh_money: 1500000 });

      await ctx.as("advisor", (t) => approvePlan(t, ctx.users.advisor, draftId));

      const plans = await ctx.tx<{ id: string; status: string; merged_into_plan_id: string | null }[]>`
        select id, status, merged_into_plan_id from public.advisory_plans where client_id = ${p.clientId} order by created_at`;
      expect(plans).toEqual([
        { id: p.planId, status: "ACTIVE", merged_into_plan_id: null },
        { id: draftId, status: "MERGED", merged_into_plan_id: p.planId },
      ]);
      const tranche = await ctx.tx<{ action: string; target_amount: number }[]>`
        select action, target_amount::float8 from public.advisory_plan_items
        where plan_id = ${p.planId} and tranche_plan_id = ${draftId} order by target_amount desc`;
      expect(tranche).toEqual([{ action: "BUY", target_amount: 1000000 }, { action: "BUY", target_amount: 500000 }]);
      const sips = await ctx.tx<{ n: number }[]>`select count(*)::int as n from public.sip_plan_items where plan_id = ${p.planId} and tranche_plan_id = ${draftId}`;
      expect(sips[0].n).toBe(1);

      // The five numbers cover both tranches; the original lines are untouched.
      const t = (await ctx.tx<{ sell_target: number; buy_target: number }[]>`
        select sell_target::float8, buy_target::float8 from public.v_plan_transition where plan_id = ${p.planId}`)[0];
      expect(t).toEqual({ sell_target: 1000000, buy_target: 600000 + 1500000 });

      const cash = (await ctx.tx<{ fresh_money: number; money_left: number }[]>`
        select fresh_money::float8, money_left::float8 from public.v_client_cash where client_id = ${p.clientId}`)[0];
      expect(cash).toEqual({ fresh_money: 1500000, money_left: 1500000 });
      const summary = (await ctx.tx<{ money_left: number }[]>`select money_left::float8 from public.v_client_summary where client_id = ${p.clientId}`)[0];
      expect(summary.money_left).toBe(1500000);

      // Recorded with a reason in the audit log.
      const audit = await ctx.tx<{ n: number }[]>`
        select count(*)::int as n from public.audit_logs where client_id = ${p.clientId} and reason like 'Tranche added%'`;
      expect(audit[0].n).toBeGreaterThan(0);
    });
  });

  it("a merged plan must point to the client's active plan; operations cannot add fresh money", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx);
      const draftId = await additionalDraft(ctx, p.clientId);
      await expect(ctx.asSuper((t) => t`
        update public.advisory_plans set status = 'MERGED', approved_at = now() where id = ${draftId}`)).rejects.toThrow(/ACTIVE plan/);
      await expect(ctx.as("ops", (t) => t`
        insert into public.client_fresh_money (client_id, amount, created_by) values (${p.clientId}, 1000, ${ctx.users.ops.id})`)).rejects.toThrow();
    });
  });

  it("with no active plan left to join, it becomes the client's plan and its fresh money still counts", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx);
      const draftId = await additionalDraft(ctx, p.clientId);
      await ctx.as("advisor", (t) => closePlan(t, p.planId, "CANCELLED", "test: plan withdrawn"));
      expect(await ctx.as("advisor", (t) => approvePlan(t, ctx.users.advisor, draftId, "tranche on its own"))).toBe("ACTIVE");
      const cash = (await ctx.tx<{ fresh_money: number; money_left: number }[]>`
        select fresh_money::float8, money_left::float8 from public.v_client_cash where client_id = ${p.clientId}`)[0];
      expect(cash).toEqual({ fresh_money: 1500000, money_left: 1500000 });
    });
  });
});
