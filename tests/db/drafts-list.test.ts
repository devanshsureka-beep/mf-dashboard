import { afterAll, describe, expect, it } from "vitest";
import { addPlanItem, addSipItem, createDraftPlan, listDraftPlans } from "@/services/plans";
import { clientWithActivePlan, scenario, sql, TEST_DB } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});

describeDb("Drafts waiting for approval", () => {
  it("lists each draft with what it moves and what is left before approval", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx);
      const draftId = await ctx.as("advisor", async (t) => {
        const id = await createDraftPlan(t, ctx.users.advisor, { clientId: p.clientId, planName: "New report", fromSnapshotId: p.snapshotId });
        await t`update public.advisory_plan_items set action = 'SELL', target_amount = 400000 where plan_id = ${id} and security_id = ${ctx.sec.X}`;
        await addPlanItem(t, ctx.users.advisor, id, { security_id: ctx.sec.Y, scheme_name: "Y", action: "BUY", target_amount: 250000 });
        await addPlanItem(t, ctx.users.advisor, id, { security_id: null, scheme_name: "Fund not found", action: "BUY", target_amount: 150000 });
        await addSipItem(t, ctx.users.advisor, id, { security_id: ctx.sec.Y, scheme_name: "Y", action: "START", new_amount: 10000 });
        // A report wording the reader could not place stays a question until answered.
        await addPlanItem(t, ctx.users.advisor, id, { security_id: ctx.sec.Y, scheme_name: "Y (review)", action: "RETAIN", target_amount: 0 });
        await t`update public.advisory_plan_items set report_question = 'What does "trim" mean here?' where plan_id = ${id} and scheme_name = 'Y (review)'`;
        return id;
      });

      const rows = await ctx.as("advisor", (t) => listDraftPlans(t));
      const d = rows.find((r) => r.plan_id === draftId);
      expect(d).toMatchObject({
        client_id: p.clientId, has_active_plan: true, sells: 1, buys: 2, keeps: 1, sell_total: 400000, buy_total: 400000,
        sip_lines: 1, open_questions: 1, needs_review: 1,
      });
      // The active plan is not a draft.
      expect(rows.some((r) => r.plan_id === p.planId)).toBe(false);
      expect((await ctx.as("advisor", (t) => listDraftPlans(t, { planId: draftId }))).map((r) => r.plan_id)).toEqual([draftId]);
      // Another advisor does not see this client's draft.
      expect((await ctx.as("otherAdvisor", (t) => listDraftPlans(t))).some((r) => r.plan_id === draftId)).toBe(false);
    });
  });
});
