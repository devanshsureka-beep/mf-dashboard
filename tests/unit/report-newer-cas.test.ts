import { describe, expect, it } from "vitest";
import { answerToReport, type ReportAiAnswer } from "@/lib/integrations/report-ai";
import { buildPlanFromReport, type PlanHolding, type SinceTrade } from "@/lib/domain/report-plan";

// The report (made from the CAS of 20-Sep): exit HDFC Flexi Regular, buy HDFC Flexi Direct, top up Axis, keep PPFAS.
const answer: ReportAiAnswer = {
  client_name: "Sample Client", report_cas_date: "2026-09-20", prepared_date: "2026-09-22", portfolio_value: 1000000,
  risk_profile: null, goal: null,
  sells: [{ fund: "HDFC Flexi Cap Fund (Regular)", folio: "1111/11", folio_count: 1, plan_type: "REGULAR", partial: false, value: 495000, percent: null }],
  sell_total: 495000,
  buys: [
    { fund: "HDFC Flexi Cap Fund", plan_type: "DIRECT", amount: 300000, kind: "NEW", amc: "HDFC", category: "Flexi Cap" },
    { fund: "Axis Small Cap Fund", plan_type: "DIRECT", amount: 195000, kind: "TOP_UP", amc: "Axis", category: "Small Cap" },
  ],
  buy_total: 495000,
  sips: [],
  holds: [
    { fund: "Axis Small Cap Fund", folio: null, folio_count: 1, plan_type: "DIRECT", value: 298000, deferred: false, note: "Core small-cap" },
    { fund: "Parag Parikh Flexi Cap", folio: null, folio_count: 1, plan_type: "DIRECT", value: 200000, deferred: false, note: "Keep" },
  ],
  report_kind: "FULL_REVIEW", fresh_money: null, cas_funds_not_in_report: [], questions: [], corrections: [],
};

// The newer CAS (10-Oct): the exit and both buys are done; a fund the report never named was bought too.
const holdings: PlanHolding[] = [
  { scheme_name: "HDFC Flexi Cap Fund - Regular Plan - Growth", isin: "INF179K01BE2", folio_number: "1111/11", current_value: 0, plan_type: "REGULAR" },
  { scheme_name: "HDFC Flexi Cap Fund - Direct Plan - Growth", isin: "INF179K01UT0", folio_number: "1111/11", current_value: 305000, plan_type: "DIRECT" },
  { scheme_name: "Axis Small Cap Fund - Direct Growth", isin: "INF846K01K35", folio_number: "2222", current_value: 500000, plan_type: "DIRECT" },
  { scheme_name: "Parag Parikh Flexi Cap Fund - Direct Plan Growth", isin: "INF879O01027", folio_number: "3333", current_value: 202000, plan_type: "DIRECT" },
  { scheme_name: "Quant Active Fund - Direct Growth", isin: "INF966L01AB1", folio_number: "4444", current_value: 51000, plan_type: "DIRECT" },
];
const trades: SinceTrade[] = [
  { scheme_name: "HDFC Flexi Cap Fund - Regular Plan - Growth", isin: "INF179K01BE2", date: "2026-08-10", type: "PURCHASE", amount: 20000 }, // before the report: history
  { scheme_name: "HDFC Flexi Cap Fund - Regular Plan - Growth", isin: "INF179K01BE2", date: "2026-09-25", type: "REDEMPTION", amount: -498000 },
  { scheme_name: "HDFC Flexi Cap Fund - Direct Plan - Growth", isin: "INF179K01UT0", date: "2026-09-26", type: "PURCHASE", amount: 300000 },
  { scheme_name: "Axis Small Cap Fund - Direct Growth", isin: "INF846K01K35", date: "2026-09-26", type: "PURCHASE", amount: 195000 },
  { scheme_name: "Quant Active Fund - Direct Growth", isin: "INF966L01AB1", date: "2026-09-27", type: "PURCHASE", amount: 50000 },
  { scheme_name: "Parag Parikh Flexi Cap Fund - Direct Plan Growth", isin: "INF879O01027", date: "2026-09-28", type: "SIP", amount: 2000 }, // a SIP is not a call
];

describe("Report + a newer CAS: differences become questions, prefilled from the trades since the report", () => {
  it("blocks on the differences without the newer-CAS option", () => {
    const plan = buildPlanFromReport(answerToReport(answer, null), holdings, "2026-10-10");
    expect(plan.problems.length).toBeGreaterThan(0);
  });

  it("asks about each difference, with what was already done", () => {
    const plan = buildPlanFromReport(answerToReport(answer, null), holdings, "2026-10-10", { since: { trades } });
    expect(plan.problems).toEqual([]);
    const by = (isin: string, action?: string) => plan.items.find((i) => i.isin === isin && (!action || i.action === action));
    // The exit is done: sold ₹4,98,000 on 25-Sep (the purchase of 10-Aug is before the report).
    expect(by("INF179K01BE2")).toMatchObject({ action: "SELL", target_amount: 495000, diff: { kind: "SELL_GONE", suggest: "SELL", done_amount: 498000, done_date: "2026-09-25" } });
    // The new fund the report buys is already held.
    expect(by("INF179K01UT0", "BUY")).toMatchObject({ target_amount: 300000, diff: { kind: "BUY_HELD", suggest: "BUY", done_amount: 300000, done_date: "2026-09-26" } });
    // The top-up is done; the Axis Keep line is not asked about again.
    expect(by("INF846K01K35", "BUY")).toMatchObject({ diff: { kind: "TRADED", suggest: "BUY", done_amount: 195000 } });
    expect(by("INF846K01K35", "RETAIN")?.question ?? null).toBeNull();
    // A fund the report never named, bought since.
    expect(by("INF966L01AB1")).toMatchObject({ action: "RETAIN", diff: { kind: "NOT_IN_REPORT", suggest: "BUY", done_amount: 50000 } });
    expect(by("INF966L01AB1")?.question).toMatch(/Not in the report.*Bought on our advice/);
    // PPFAS: kept, only a SIP since the report: nothing to ask.
    expect(by("INF879O01027")?.question ?? null).toBeNull();
  });

  it("prefers a sold-out fund over a look-alike still held, keeps the report's own question, and asks about trades of funds no line covers", () => {
    const ans: ReportAiAnswer = {
      ...answer,
      sells: [{ fund: "Aditya Birla Sun Life Digital India Fund", folio: null, folio_count: 1, plan_type: "REGULAR", partial: false, value: 400000, percent: null }],
      sell_total: null, buys: [], buy_total: null,
      holds: [{ fund: "Aditya Birla Sun Life Flexi Cap Fund", folio: null, folio_count: 1, plan_type: "REGULAR", value: 700000, deferred: false, note: "Hold" }],
      questions: [{ fund: "HDFC Dividend Yield Fund", folio: null, folio_count: 1, plan_type: "REGULAR", report_text: "Trim", question: "Trim by how much?" }],
    };
    const h: PlanHolding[] = [
      { scheme_name: "Aditya Birla Sun Life Flexi Cap Fund - Growth-Regular Plan", isin: "INF209K01AJ8", folio_number: "9", current_value: 706000, plan_type: "REGULAR" },
    ];
    const t: SinceTrade[] = [
      { scheme_name: "Aditya Birla Sun Life Digital India Fund - Growth-Regular Plan", isin: "INF209K01AV3", date: "2026-09-25", type: "REDEMPTION", amount: -429000 },
      { scheme_name: "HDFC Dividend Yield Fund - Regular Plan - Growth", isin: "INF179KC1981", date: "2026-09-25", type: "REDEMPTION", amount: -990000 },
      { scheme_name: "ICICI Prudential Aggressive Hybrid Fund - Growth", isin: "INF109K01480", date: "2026-09-25", type: "REDEMPTION", amount: -1100000 },
    ];
    const plan = buildPlanFromReport(answerToReport(ans, null), h, "2026-10-10", { since: { trades: t } });
    expect(plan.problems).toEqual([]);
    // The exit is the sold-out Digital India fund, not the Flexi Cap still held.
    expect(plan.items.find((i) => i.isin === "INF209K01AV3")).toMatchObject({ action: "SELL", diff: { kind: "SELL_GONE", done_amount: 429000 } });
    expect(plan.items.find((i) => i.isin === "INF209K01AJ8")).toMatchObject({ action: "RETAIN" });
    // The report's trim question keeps its words, with what the CAS shows.
    expect(plan.items.find((i) => /Dividend/.test(i.scheme_name))?.question).toMatch(/^Trim by how much\? The new CAS shows ₹9,90,000 sold since the report/);
    // A fund the report calls by another name: its trades still get a question.
    expect(plan.items.find((i) => i.isin === "INF109K01480")).toMatchObject({ action: "RETAIN", diff: { kind: "TRADED", suggest: "SELL", done_amount: 1100000 } });
  });

  it("a sell naming another folio, a multi-folio exit already done and a SIP stop on an exited fund do not block", () => {
    const ans: ReportAiAnswer = {
      ...answer,
      sells: [
        { fund: "HDFC Balanced Advantage Fund (Regular)", folio: "19970693", folio_count: 1, plan_type: "REGULAR", partial: false, value: 64670, percent: null },
        { fund: "Aditya Birla SL Digital India Fund (Regular)", folio: null, folio_count: 2, plan_type: "REGULAR", partial: false, value: 51495, percent: null },
      ],
      sell_total: null, buys: [], buy_total: null,
      holds: [{ fund: "HDFC Balanced Advantage Fund (Regular)", folio: "12605858", folio_count: 1, plan_type: "REGULAR", value: 285895, deferred: false, note: "Held as-is" }],
      sips: [{ fund: "PPFAS Parag Parikh Flexi Cap Fund (Direct)", plan_type: "DIRECT", change: "STOP", current: 5000, next: 0 }],
    };
    const h: PlanHolding[] = [
      { scheme_name: "HDFC Balanced Advantage Fund - Regular Plan - Growth", isin: "INF179K01830", folio_number: "12605858/10", current_value: 277000, plan_type: "REGULAR" },
    ];
    const t: SinceTrade[] = [
      { scheme_name: "HDFC Balanced Advantage Fund - Regular Plan - Growth", isin: "INF179K01830", date: "2026-09-22", type: "REDEMPTION", amount: -64706 },
      { scheme_name: "Aditya Birla Sun Life Digital India Fund - Growth-Regular Plan", isin: "INF209K01AV3", date: "2026-09-22", type: "REDEMPTION", amount: -51352 },
    ];
    const plan = buildPlanFromReport(answerToReport(ans, null), h, "2026-10-12", { since: { trades: t } });
    expect(plan.problems).toEqual([]);
    // The sold folio is its own Sell (done); the folio the report keeps stays a Keep.
    expect(plan.items.find((i) => i.action === "SELL" && /Balanced/.test(i.scheme_name))).toMatchObject({ folio_number: "19970693", diff: { kind: "SELL_GONE", done_amount: 64706 } });
    expect(plan.items.find((i) => i.folio_number === "12605858/10")).toMatchObject({ action: "RETAIN" });
    expect(plan.items.find((i) => i.isin === "INF209K01AV3")).toMatchObject({ action: "SELL", diff: { kind: "SELL_GONE", done_amount: 51352 } });
    expect(plan.sip_items).toEqual([]);
    expect(plan.drift.join(" ")).toMatch(/SIP stop for PPFAS.*already exited/);
  });
});
