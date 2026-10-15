import { describe, expect, it } from "vitest";
import { answerToReport, type ReportAiAnswer } from "@/lib/integrations/report-ai";
import { buildPlanFromReport, type PlanHolding } from "@/lib/domain/report-plan";

// The client's CAS holds ₹1 Cr; the report advises on ₹50L of it (the client asked for that).
const answer: ReportAiAnswer = {
  client_name: "Sample Client", report_cas_date: "2026-10-01", prepared_date: "2026-10-03", portfolio_value: 5000000,
  risk_profile: null, goal: null,
  sells: [
    { fund: "HDFC Flexi Cap Fund (Regular)", folio: "1111/11", folio_count: 1, plan_type: "REGULAR", partial: false, value: 2000000, percent: null },
    { fund: "Axis Bluechip Fund", folio: "5555", folio_count: 1, plan_type: "DIRECT", partial: true, value: 900000, percent: null },
  ],
  sell_total: 2900000,
  buys: [{ fund: "Parag Parikh Flexi Cap Fund", plan_type: "DIRECT", amount: 2900000, kind: "NEW", amc: "PPFAS", category: "Flexi Cap" }],
  buy_total: 2900000,
  sips: [],
  holds: [{ fund: "Kotak Emerging Equity", folio: null, folio_count: 1, plan_type: "DIRECT", value: 1100000, deferred: false, note: "Core" }],
  report_kind: "FULL_REVIEW", fresh_money: null, cas_funds_not_in_report: [], questions: [], corrections: [],
};

const holdings: PlanHolding[] = [
  // The CAS holds ₹23L where the report sells ₹20L as a full exit (differs by more than NAV movement on the same date).
  { scheme_name: "HDFC Flexi Cap Fund - Regular Plan - Growth", isin: "INF179K01BE2", folio_number: "1111/11", current_value: 2300000, plan_type: "REGULAR" },
  { scheme_name: "Axis Bluechip Fund - Direct Plan Growth", isin: "INF846K01DP8", folio_number: "5555", current_value: 800000, plan_type: "DIRECT" },
  { scheme_name: "Kotak Emerging Equity Fund - Direct Growth", isin: "INF174K01LS2", folio_number: "6666", current_value: 1100000, plan_type: "DIRECT" },
  // Outside the advised ₹50L: the report never mentions these.
  { scheme_name: "SBI Small Cap Fund - Direct Growth", isin: "INF200K01T51", folio_number: "7777", current_value: 3000000, plan_type: "DIRECT" },
  { scheme_name: "ICICI Prudential Bluechip Fund - Direct Growth", isin: "INF109K016L0", folio_number: "8888", current_value: 2800000, plan_type: "DIRECT" },
];

describe("Onboard with the report as it is", () => {
  it("normally blocks on the differences", () => {
    const plan = buildPlanFromReport(answerToReport(answer, null), holdings, "2026-10-01");
    expect(plan.problems.length).toBeGreaterThanOrEqual(3);
  });

  it("follows the report: full exit = whole holding, trims capped, funds outside the report left out", () => {
    const plan = buildPlanFromReport(answerToReport(answer, null), holdings, "2026-10-01", { asReported: true });
    expect(plan.problems).toEqual([]);
    const by = (isin: string) => plan.items.find((i) => i.isin === isin);
    // A full exit sells every unit the CAS holds.
    expect(by("INF179K01BE2")).toMatchObject({ action: "SELL", target_amount: 2300000 });
    // A trim never sells more than is held.
    expect(by("INF846K01DP8")).toMatchObject({ action: "SELL", target_amount: 800000 });
    expect(by("INF174K01LS2")).toMatchObject({ action: "RETAIN" });
    expect(plan.items.find((i) => i.action === "BUY")).toMatchObject({ target_amount: 2900000 });
    // The rest of the portfolio is outside the advised portfolio: no plan line.
    expect(by("INF200K01T51")).toBeUndefined();
    expect(by("INF109K016L0")).toBeUndefined();
    expect((plan.outside ?? []).map((h) => h.isin).sort()).toEqual(["INF109K016L0", "INF200K01T51"]);
    // The advised portfolio is the report's ₹50L, not the CAS's ₹1 Cr.
    expect(plan.starting_portfolio_value).toBe(5000000);
    // Nothing is asked.
    expect(plan.items.some((i) => i.question || i.diff)).toBe(false);
  });
});

describe("SIPs the report keeps unchanged", () => {
  it("are tied to the CAS fund and kept apart from the plan's SIP lines", () => {
    const report = { ...answerToReport(answer, null), sipsUnchanged: [{ fund: "Kotak Emerging Equity", planType: "DIRECT" as const, amount: 15000 }] };
    const plan = buildPlanFromReport(report, holdings, "2026-10-01", { asReported: true });
    expect(plan.unchanged_sips).toEqual([{ scheme_name: "Kotak Emerging Equity Fund - Direct Growth", isin: "INF174K01LS2", amount: 15000 }]);
    expect(plan.sip_items).toEqual([]);
  });
});
