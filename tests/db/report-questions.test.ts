import { afterAll, describe, expect, it } from "vitest";
import { advisoryReportResultSchema } from "@/lib/integrations/contracts";
import { answerReportQuestion, approvePlan, ingestAdvisoryReport, listReportQuestions, reopenReportQuestion, updatePlanItem } from "@/services/plans";
import { issueAdvice } from "@/services/advice";
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
      // Undo on the draft: the line is a question again, as the report gave it; then it can be answered anew.
      const before = (await ctx.tx<{ reason: string }[]>`select reason from public.advisory_plan_items where id = ${y.id}`)[0].reason;
      await ctx.as("advisor", (t) => answerReportQuestion(t, ctx.users.advisor, y.id, { action: "SELL", amount: 50000, explanation: "first try" }));
      await ctx.as("advisor", (t) => reopenReportQuestion(t, ctx.users.advisor, y.id));
      const back = (await ctx.tx<{ action: string; target_amount: number; report_answer: string | null; reason: string; needs_review: boolean }[]>`
        select action, target_amount::float8, report_answer, reason, needs_review from public.advisory_plan_items where id = ${y.id}`)[0];
      expect(back).toEqual({ action: "RETAIN", target_amount: 0, report_answer: null, reason: before, needs_review: true });
      // A percentage is for a Sell only.
      expect(await ctx.expectError("advisor", (t) => answerReportQuestion(t, ctx.users.advisor, y.id, { action: "BUY", percent: 33, explanation: "x" }))).toMatch(/only for a Sell/);
      // A line that was a Sell with an amount comes back as that Sell.
      await ctx.tx`update public.advisory_plan_items set action = 'SELL', target_amount = 40000 where id = ${y.id}`;
      await ctx.as("advisor", (t) => answerReportQuestion(t, ctx.users.advisor, y.id, { action: "RETAIN", explanation: "keep" }));
      await ctx.as("advisor", (t) => reopenReportQuestion(t, ctx.users.advisor, y.id));
      expect((await ctx.tx<{ action: string; target_amount: number }[]>`select action, target_amount::float8 from public.advisory_plan_items where id = ${y.id}`)[0])
        .toEqual({ action: "SELL", target_amount: 40000 });
      await ctx.as("advisor", (t) => answerReportQuestion(t, ctx.users.advisor, y.id, { action: "RETAIN", explanation: "Trim deferred to next tranche" }));

      // Answered once: a second answer is refused (the first already rewrote the line).
      expect(await ctx.expectError("advisor", (t) => answerReportQuestion(t, ctx.users.advisor, y.id, { action: "SELL", percent: 50, explanation: "changed my mind" }))).toMatch(/already answered/);

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

describeDb("Report + a newer CAS: a difference answered as already done", () => {
  it("records the part done before onboarding as a call + execution when the plan is approved", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx); // baseline CAS of 01-Sep: X 10,000 units @150 (₹15L)
      const x = (await ctx.tx<{ scheme_name: string }[]>`select scheme_name from public.security_master where id = ${ctx.sec.X}`)[0];
      const payload = advisoryReportResultSchema.parse({
        client_id: p.clientId, status: "PARSED", plan: { plan_name: "Report with a newer CAS" },
        items: [{
          action: "SELL", scheme_name: x.scheme_name, target_amount: 500000, current_amount: 1500000, reason: "Trim",
          question: "The report sells ₹5,00,000; the new CAS holds ₹15,00,000 (₹2,00,000 sold since the report). How much is done?",
          report_diff: { kind: "SELL_CHANGED", report_amount: 500000, cas_value: 1500000, sold_since: 200000, bought_since: 0, suggest: "SELL", done_amount: 200000, done_date: "2026-08-25" },
        }],
      });
      const draft = await ctx.as("advisor", (t) => ingestAdvisoryReport(t, payload, ctx.users.advisor.id, { extractionSource: "IMPORT", securityIds: { [x.scheme_name.toLowerCase()]: ctx.sec.X } }));
      const planId = draft.planId!;
      const [q] = await ctx.as("advisor", (t) => listReportQuestions(t, planId));
      expect(q.report_diff).toMatchObject({ kind: "SELL_CHANGED", done_amount: 200000, done_date: "2026-08-25" });

      // A Keep cannot carry a part done on our advice; the done part cannot exceed the line.
      expect(await ctx.expectError("advisor", (t) => answerReportQuestion(t, ctx.users.advisor, q.id, { action: "RETAIN", explanation: "client's own", done: { amount: 200000, date: "2026-08-25" } }))).toMatch(/Keep has nothing done/);
      expect(await ctx.expectError("advisor", (t) => answerReportQuestion(t, ctx.users.advisor, q.id, { action: "SELL", amount: 100000, explanation: "x", done: { amount: 200000, date: "2026-08-25" } }))).toMatch(/more than the line/);

      await ctx.as("advisor", (t) => answerReportQuestion(t, ctx.users.advisor, q.id, { action: "SELL", amount: 500000, explanation: "₹2L sold on our advice before onboarding", done: { amount: 200000, date: "2026-08-25" } }));
      // On the draft nothing is recorded yet; approval records the call and its execution.
      expect((await ctx.tx<{ n: number }[]>`select count(*)::int as n from public.advice_items where plan_item_id = ${q.id}`)[0].n).toBe(0);
      await ctx.as("advisor", (t) => approvePlan(t, ctx.users.advisor, planId, "report with a newer CAS"));
      const prog = (await ctx.tx<{ target_amount: number; advised_amount: number; executed_amount: number; yet_to_advise_amount: number }[]>`
        select target_amount::float8, advised_amount::float8, executed_amount::float8, yet_to_advise_amount::float8 from public.v_plan_item_progress where plan_item_id = ${q.id}`)[0];
      expect(prog).toEqual({ target_amount: 500000, advised_amount: 200000, executed_amount: 200000, yet_to_advise_amount: 300000 });
      const ex = (await ctx.tx<{ verification_type: string; execution_date: string }[]>`
        select e.verification_type, e.execution_date::text from public.executions e join public.advice_items ai on ai.id = e.advice_item_id where ai.plan_item_id = ${q.id}`)[0];
      expect(ex).toEqual({ verification_type: "PROOF_VERIFIED", execution_date: "2026-08-25" });
      // Approving again (or answering again) never records it twice.
      const lines = await ctx.tx<{ report_diff: { done_call_id?: string } }[]>`select report_diff from public.advisory_plan_items where id = ${q.id}`;
      expect(lines[0].report_diff.done_call_id).toBeTruthy();
      // The cash from it was the client's at onboarding (dated before the onboarding CAS).
      const bank = (await ctx.as("advisor", (t) => t<{ cash_at_onboarding: number }[]>`
        select cash_at_onboarding::float8 from public.v_client_bank where client_id = ${p.clientId}`))[0];
      expect(bank.cash_at_onboarding).toBe(200000);
    });
  });

  it("a Buy done before onboarding with money the desk never saw does not lower the start value", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx);
      const y = (await ctx.tx<{ scheme_name: string }[]>`select scheme_name from public.security_master where id = ${ctx.sec.Y}`)[0];
      const payload = advisoryReportResultSchema.parse({
        client_id: p.clientId, status: "PARSED", plan: { plan_name: "Buy done earlier" },
        items: [{
          action: "BUY", scheme_name: y.scheme_name, target_amount: 100000, current_amount: 0, reason: "Buy",
          question: "Already bought?", report_diff: { kind: "BUY_HELD", report_amount: 100000, cas_value: 100000, sold_since: 0, bought_since: 100000, suggest: "BUY", done_amount: 100000, done_date: "2026-08-20" },
        }],
      });
      const draft = await ctx.as("advisor", (t) => ingestAdvisoryReport(t, payload, ctx.users.advisor.id, { extractionSource: "IMPORT", securityIds: { [y.scheme_name.toLowerCase()]: ctx.sec.Y } }));
      const [q] = await ctx.as("advisor", (t) => listReportQuestions(t, draft.planId!));
      await ctx.as("advisor", (t) => answerReportQuestion(t, ctx.users.advisor, q.id, { action: "BUY", amount: 100000, explanation: "bought before onboarding", done: { amount: 100000, date: "2026-08-20" } }));
      await ctx.as("advisor", (t) => approvePlan(t, ctx.users.advisor, draft.planId!, "buy done earlier"));
      const bank = (await ctx.as("advisor", (t) => t<{ in_bank: number; cash_at_onboarding: number }[]>`
        select in_bank::float8, cash_at_onboarding::float8 from public.v_client_bank where client_id = ${p.clientId}`))[0];
      expect(bank).toEqual({ in_bank: 0, cash_at_onboarding: 0 });
    });
  });
});

describeDb("Additional plan with a part already done", () => {
  it("merging into the active plan keeps the answer and records the done part", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx);
      const y = (await ctx.tx<{ scheme_name: string }[]>`select scheme_name from public.security_master where id = ${ctx.sec.Y}`)[0];
      const payload = advisoryReportResultSchema.parse({
        client_id: p.clientId, status: "PARSED", plan: { plan_name: "Top-up", plan_kind: "ADDITIONAL", fresh_money: 200000 },
        items: [{
          action: "BUY", scheme_name: y.scheme_name, target_amount: 200000, current_amount: 0, reason: "Buy",
          question: "Already bought?", report_diff: { kind: "BUY_HELD", report_amount: 200000, cas_value: 50000, sold_since: 0, bought_since: 50000, suggest: "BUY", done_amount: 50000, done_date: "2026-09-05" },
        }],
      });
      const draft = await ctx.as("advisor", (t) => ingestAdvisoryReport(t, payload, ctx.users.advisor.id, { extractionSource: "IMPORT", securityIds: { [y.scheme_name.toLowerCase()]: ctx.sec.Y } }));
      const [q] = await ctx.as("advisor", (t) => listReportQuestions(t, draft.planId!));
      await ctx.as("advisor", (t) => answerReportQuestion(t, ctx.users.advisor, q.id, { action: "BUY", amount: 200000, explanation: "₹50k bought on our advice", done: { amount: 50000, date: "2026-09-05" } }));
      expect(await ctx.as("advisor", (t) => approvePlan(t, ctx.users.advisor, draft.planId!, "top-up"))).toBe("MERGED");
      const merged = (await ctx.tx<{ id: string; report_answer: string | null; report_diff: { done_call_id?: string } | null }[]>`
        select id, report_answer, report_diff from public.advisory_plan_items where plan_id = ${p.planId} and tranche_plan_id = ${draft.planId!}`)[0];
      expect(merged.report_answer).toBe("₹50k bought on our advice");
      expect(merged.report_diff?.done_call_id).toBeTruthy();
      const prog = (await ctx.tx<{ advised_amount: number; executed_amount: number }[]>`
        select advised_amount::float8, executed_amount::float8 from public.v_plan_item_progress where plan_item_id = ${merged.id}`)[0];
      expect(prog).toEqual({ advised_amount: 50000, executed_amount: 50000 });
    });
  });
});

describeDb("Editing an active plan line", () => {
  it("keeps its notes, and refuses a new action or fund once it has calls", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx);
      await ctx.tx`update public.advisory_plan_items set notes = 'client asked to wait' where id = ${p.sellItem}`;
      const line = { security_id: ctx.sec.X, scheme_name: "X", action: "SELL" as const, target_amount: 900000 };
      await ctx.as("advisor", (t) => updatePlanItem(t, p.sellItem, line, "smaller sell"));
      expect((await ctx.tx<{ notes: string }[]>`select notes from public.advisory_plan_items where id = ${p.sellItem}`)[0].notes).toBe("client asked to wait");

      await ctx.as("advisor", (t) => issueAdvice(t, ctx.users.advisor, {
        clientId: p.clientId, communicatedAt: new Date("2026-09-10T10:00:00+05:30"), channel: "PHONE",
        items: [{ plan_item_id: p.sellItem, security_id: ctx.sec.X, action: "SELL", quantity_basis: "AMOUNT", advised_amount: 100000 }],
      }));
      expect(await ctx.expectError("advisor", (t) => updatePlanItem(t, p.sellItem, { ...line, action: "BUY" }, "flip"))).toMatch(/already has calls/);
      expect(await ctx.expectError("advisor", (t) => updatePlanItem(t, p.sellItem, { ...line, security_id: ctx.sec.Y }, "other fund"))).toMatch(/already has calls/);
      // The amount can still change.
      await ctx.as("advisor", (t) => updatePlanItem(t, p.sellItem, { ...line, target_amount: 800000 }, "smaller again"));
    });
  });
});
