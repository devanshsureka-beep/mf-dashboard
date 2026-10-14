import { afterAll, describe, expect, it } from "vitest";
import type { AdvisoryReportParse } from "@/lib/parsers/advisory-report";
import { issueAdvice } from "@/services/advice";
import { approvePlan } from "@/services/plans";
import { confirmSnapshot, createSnapshotFromParsed } from "@/services/portfolio";
import { createNewInvestor, newInvestorPlan, previewNewInvestor } from "@/services/onboarding";
import { runReconciliation } from "@/services/reconciliation";
import { parsed, scenario, sql, TEST_DB } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});

const report = (over: Partial<AdvisoryReportParse> = {}): AdvisoryReportParse => ({
  template: "GENERIC_TABLES", clientName: "Kavya Iyer", riskProfile: "MODERATE", goal: "Long-term wealth",
  casPeriod: { from: null, to: null }, valuationDate: null, preparedDate: "2026-10-10", currentValue: null,
  sells: [], sellTotal: null,
  buys: [
    { fund: "Sample Large Cap Fund - Direct Plan - Growth", amc: "Sample AMC", category: "Large Cap", planType: "DIRECT", amount: 300000, mode: null, fundedBy: null, kind: "NEW" },
    { fund: "Sample Flexi Cap Fund - Direct Plan - Growth", amc: "Sample AMC", category: "Flexi Cap", planType: "DIRECT", amount: 200000, mode: null, fundedBy: null, kind: "NEW" },
  ],
  buyTotal: 500000,
  sips: [{ fund: "Sample Flexi Cap Fund - Direct Plan - Growth", planType: "DIRECT", current: null, next: 10000, change: "START", changeText: "Start", frequencyNote: null, excludedFromTotal: false }],
  sipTotals: { current: null, next: 10000 }, sipRouting: [], review: [], holds: [], mentioned: [], deploymentNotes: [],
  problems: [], warnings: [],
  ...over,
});

describeDb("A new investor with no mutual funds yet (no CAS)", () => {
  it("refuses what a new investor cannot have, and a wrong name or PAN", () => {
    const who = { fullName: "Kavya Iyer", pan: "ABCDE1234F" };
    expect(previewNewInvestor(report(), who).problems).toEqual([]);
    expect(previewNewInvestor(report(), { ...who, pan: "123" }).problems[0]).toMatch(/valid PAN/);
    expect(previewNewInvestor(report(), { ...who, fullName: "Someone Else" }).problems[0]).toMatch(/is for "Kavya Iyer"/);
    const withSell = report({ sells: [{ fund: "Old Fund", folio: null, actionText: "Exit", action: "SELL", partial: false, value: 1000 }] });
    expect(previewNewInvestor(withSell, who).problems[0]).toMatch(/already holds mutual funds/);
    expect(previewNewInvestor(report({ buys: [], sips: [] }), who).problems.join(" ")).toMatch(/no fund to buy/);
  });

  it("starts from nothing: the plan buys with fresh money, and the first CAS completes the buys", async () => {
    await scenario(async (ctx) => {
      const who = { fullName: "Kavya Iyer", pan: `KAVYA${String(Math.floor(Math.random() * 1e4)).padStart(4, "0")}F` };
      const r = report();
      const client = await ctx.as("advisor", (t) => createNewInvestor(t, ctx.users.advisor, { who, report: r }));
      // Stopped before the plan was saved: trying again carries on with the same client.
      const again = await ctx.as("advisor", (t) => createNewInvestor(t, ctx.users.advisor, { who, report: r }));
      expect(again.id).toBe(client.id);
      const plan = await ctx.as("advisor", (t) => newInvestorPlan(t, ctx.users.advisor, {
        clientId: client.id, who, report: r,
        reportFile: { fileName: "report.pdf", mimeType: "application/pdf", size: 10, sha256: "a".repeat(64), path: `${client.id}/ADVISORY_REPORT/report.pdf` },
      }));

      // Once the client has a plan, the same PAN cannot be onboarded again.
      expect(await ctx.expectError("advisor", (t) => createNewInvestor(t, ctx.users.advisor, { who, report: r }))).toMatch(/already has this PAN/);

      const p = (await ctx.tx<{ plan_name: string; plan_kind: string; fresh_money: number; buy_target: number; sell_target: number }[]>`
        select a.plan_name, a.plan_kind, a.fresh_money::float8, t.buy_target::float8, t.sell_target::float8
        from public.advisory_plans a join public.v_plan_transition t on t.plan_id = a.id where a.id = ${plan.planId}`)[0];
      expect(p).toMatchObject({ plan_kind: "FULL", fresh_money: 500000, buy_target: 500000, sell_target: 0 });
      expect(p.plan_name).toMatch(/^First investment plan/);
      const sip = await ctx.tx<{ action: string; new_amount: number }[]>`select action, new_amount::float8 from public.sip_plan_items where plan_id = ${plan.planId}`;
      expect(sip).toEqual([{ action: "START", new_amount: 10000 }]);

      // Lines whose fund was created by name need review; resolve them as the advisor would.
      await ctx.asSuper((t) => t`update public.advisory_plan_items set needs_review = false where plan_id = ${plan.planId}`);
      await ctx.asSuper((t) => t`update public.sip_plan_items set needs_review = false where plan_id = ${plan.planId}`);
      await ctx.as("advisor", (t) => approvePlan(t, ctx.users.advisor, plan.planId, "first plan"));
      const bank = (await ctx.tx<{ fresh_money: number; money_left: number }[]>`
        select fresh_money::float8, money_left::float8 from public.v_client_cash where client_id = ${client.id}`)[0];
      expect(bank).toEqual({ fresh_money: 500000, money_left: 500000 });

      // A buy call today, the client buys today, the first CAS shows it.
      const line = (await ctx.tx<{ id: string; security_id: string; scheme_name: string }[]>`
        select id, security_id, scheme_name from public.advisory_plan_items where plan_id = ${plan.planId} and target_amount = 300000`)[0];
      const today = (await ctx.tx<{ d: string }[]>`select app.today_ist()::text as d`)[0].d;
      const call = await ctx.as("advisor", (t) => issueAdvice(t, ctx.users.advisor, {
        clientId: client.id, communicatedAt: new Date(`${today}T09:00:00+05:30`), channel: "PHONE",
        items: [{ plan_item_id: line.id, security_id: line.security_id, action: "BUY", quantity_basis: "AMOUNT", advised_amount: 300000 }],
      }));
      const snap = await ctx.as("ops", async (t) => {
        const pr = parsed(today, [{ security: line.security_id, name: line.scheme_name, units: 3000, nav: 100 }], [
          { date: today, type: "PURCHASE", scheme_name: line.scheme_name, isin: null, folio_number: "T1", amount: 300000, units: 3000, nav: 100, balance_units: 3000 },
        ]);
        const id = await createSnapshotFromParsed(t, { clientId: client.id, casDocumentId: null, parsed: pr, source: "CAS", createdBy: ctx.users.ops.id });
        const c = await confirmSnapshot(t, id, "checked");
        expect(c.isBaseline).toBe(false); // the empty start is the baseline
        expect(c.previousSnapshotId).not.toBeNull();
        return id;
      });
      await ctx.as("ops", (t) => runReconciliation(t, ctx.users.ops, { clientId: client.id, currentSnapshotId: snap }));
      const done = (await ctx.tx<{ status: string; executed_amount: number }[]>`
        select status, executed_amount::float8 from public.v_advice_items where id = ${call.itemIds[0]}`)[0];
      expect(done).toEqual({ status: "EXECUTED", executed_amount: 300000 });
      const after = (await ctx.tx<{ money_left: number }[]>`select money_left::float8 from public.v_client_cash where client_id = ${client.id}`)[0];
      expect(after.money_left).toBe(200000);
    });
  });
});
