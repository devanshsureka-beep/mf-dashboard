import { afterAll, describe, expect, it } from "vitest";
import { advisoryReportResultSchema } from "@/lib/integrations/contracts";
import { answerReportQuestion, approvePlan, ingestAdvisoryReport, listReportQuestions, updatePlanItem } from "@/services/plans";
import { clientWithActivePlan, scenario, sql, TEST_DB } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});

describeDb("Questions from the report", () => {
  it("keeps an unclear fund as a question; the plan waits for the answer, which becomes a Sell / Keep", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx);
      const names = await ctx.tx<{ id: string; scheme_name: string }[]>`select id, scheme_name from public.security_master where id in (${ctx.sec.X}, ${ctx.sec.Y})`;
      const nameOf = (id: string) => names.find((n) => n.id === id)!.scheme_name;
      const payload = advisoryReportResultSchema.parse({
        client_id: p.clientId, status: "PARSED", plan: { plan_name: "With a question" },
        items: [
          { action: "RETAIN", scheme_name: nameOf(ctx.sec.X), target_amount: 0, current_amount: 300000, reason: "Report: Rebalance towards target", question: "Sell how much, or keep?" },
          { action: "RETAIN", scheme_name: nameOf(ctx.sec.Y), target_amount: 0, current_amount: 100000, reason: "Report: Trim (no amount given)", question: "How much should be sold?" },
        ],
      });
      const ids = { [nameOf(ctx.sec.X).toLowerCase()]: ctx.sec.X, [nameOf(ctx.sec.Y).toLowerCase()]: ctx.sec.Y };
      const draft = await ctx.as("advisor", (t) => ingestAdvisoryReport(t, payload, ctx.users.advisor.id, { extractionSource: "AI_EXTRACTION", securityIds: ids }));
      const planId = draft.planId!;
      let qs = await ctx.as("advisor", (t) => listReportQuestions(t, planId));
      expect(qs.map((q) => [q.report_question, q.open])).toEqual([["Sell how much, or keep?", true], ["How much should be sold?", true]]);

      // Not approvable while a question is open.
      expect(await ctx.expectError("advisor", (t) => approvePlan(t, ctx.users.advisor, planId, "go"))).toMatch(/review/i);

      const [x, y] = qs;
      // Editing the line (e.g. picking the fund) does not answer the question.
      await ctx.as("advisor", (t) => updatePlanItem(t, x.id, { security_id: ctx.sec.X, scheme_name: nameOf(ctx.sec.X), action: "RETAIN", target_amount: 0, current_amount: 300000, reason: "Report: Rebalance towards target" }));
      expect(await ctx.expectError("advisor", (t) => approvePlan(t, ctx.users.advisor, planId, "go"))).toMatch(/review/i);
      expect(await ctx.expectError("ops", (t) => answerReportQuestion(t, ctx.users.ops, x.id, { action: "RETAIN", explanation: "keep" }))).toMatch(/advisor or admin/);
      expect(await ctx.expectError("advisor", (t) => answerReportQuestion(t, ctx.users.advisor, x.id, { action: "SELL", percent: 33, explanation: " " }))).toMatch(/Explain/);
      await ctx.as("advisor", (t) => answerReportQuestion(t, ctx.users.advisor, x.id, { action: "SELL", percent: 33, explanation: "Advisor confirmed: sell a third" }));
      await ctx.as("advisor", (t) => answerReportQuestion(t, ctx.users.advisor, y.id, { action: "RETAIN", explanation: "Trim deferred to next tranche" }));

      qs = await ctx.as("advisor", (t) => listReportQuestions(t, planId));
      expect(qs.every((q) => !q.open)).toBe(true);
      const lines = await ctx.tx<{ action: string; target_amount: number; needs_review: boolean; report_answer: string; reason: string }[]>`
        select action, target_amount::float8, needs_review, report_answer, reason from public.advisory_plan_items where plan_id = ${planId} order by (id = ${x.id}) desc`;
      expect(lines[0]).toMatchObject({ action: "SELL", target_amount: 99000, needs_review: false, report_answer: "Advisor confirmed: sell a third" });
      expect(lines[0].reason).toMatch(/Rebalance towards target → Sell ₹99,000 \(33%\): Advisor confirmed/);
      expect(lines[1]).toMatchObject({ action: "RETAIN", target_amount: 0, needs_review: false });

      await ctx.as("advisor", (t) => approvePlan(t, ctx.users.advisor, planId, "questions answered"));
    });
  });
});
