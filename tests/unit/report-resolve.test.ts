import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { answerToReport, type ReportAiAnswer } from "@/lib/integrations/report-ai";
import { buildPlanFromReport } from "@/lib/domain/report-plan";
import { parseCasLines } from "@/lib/parsers/cas";
import { decideReportKind, holdingsFromCas } from "@/services/onboarding";
import { resolveWithClaude } from "@/services/report-resolve";

const cas = parseCasLines(readFileSync("tests/fixtures/cas-kfin-cams.sample.txt", "utf8").split("\n"));
const hold = (fund: string, value: number) => ({ fund, folio: null, folio_count: 1, plan_type: "DIRECT" as const, value, deferred: false, note: null });

// Sells HDFC Defence, keeps four funds; HSBC Value is never mentioned in the report.
const base: ReportAiAnswer = {
  client_name: "Test Investor", report_cas_date: "2026-09-18", prepared_date: null, portfolio_value: null, risk_profile: null, goal: null,
  sells: [{ fund: "HDFC Defence Fund", folio: "00004000/14", folio_count: 1, plan_type: "DIRECT", partial: false, value: 227651.49 }],
  sell_total: 227651.49,
  buys: [{ fund: "Parag Parikh Flexi Cap Fund", plan_type: "DIRECT", amount: 227651.49, kind: "NEW", amc: null, category: null }],
  buy_total: 227651.49,
  sips: [],
  holds: [
    hold("360 ONE Flexicap Fund", 31823.12), hold("Aditya Birla Sun Life Consumption Fund", 21669.09),
    hold("Aditya Birla Sun Life Digital India Fund", 31962.52), hold("Axis India Manufacturing Fund", 26697.62),
  ],
  report_kind: "FULL_REVIEW", fresh_money: null,
  cas_funds_not_in_report: [],
  corrections: ["Read the sell table."],
};
const reply = (a: ReportAiAnswer) => ({ report: answerToReport(a, null), corrections: a.corrections });
const far = () => Date.now() + 600_000;

describe("Claude resolves what the built-in reader could not, in rounds", () => {
  it("a TRIM with no amount is kept with a note for the advisor, not a sell and not a blocker", () => {
    const trim = answerToReport({ ...base, holds: base.holds.slice(1), sells: [...base.sells, { fund: "360 ONE Flexicap Fund (formerly IIFL Focused Equity Fund)", folio: null, folio_count: 1, plan_type: "DIRECT", partial: true, value: 0 }], cas_funds_not_in_report: ["HSBC Value Fund - Direct Growth"] }, null);
    expect(trim.problems).toEqual([]);
    const plan = buildPlanFromReport(trim, holdingsFromCas(cas), cas.valuationDate);
    expect(plan.problems).toEqual([]);
    expect(plan.items.find((i) => /360 ONE/.test(i.scheme_name))).toMatchObject({ action: "RETAIN", reason: expect.stringMatching(/TRIM advised .* advisor to set the amount/) });
    expect(plan.notes).toMatch(/360 ONE .* says TRIM but gives no amount/);
  });

  it("a CAS fund the report never mentions blocks, unless Claude confirms it is absent; then it is kept and flagged", () => {
    const plan1 = buildPlanFromReport(answerToReport(base, null), holdingsFromCas(cas), cas.valuationDate);
    expect(plan1.problems).toEqual([expect.stringMatching(/HSBC Value Fund .* not covered by the report/)]);
    const confirmed = answerToReport({ ...base, cas_funds_not_in_report: ["HSBC Value Fund - Direct Growth"] }, null);
    const plan2 = buildPlanFromReport(confirmed, holdingsFromCas(cas), cas.valuationDate);
    expect(plan2.problems).toEqual([]);
    expect(plan2.items.find((i) => /HSBC/.test(i.scheme_name))).toMatchObject({ action: "RETAIN", reason: expect.stringMatching(/Not mentioned in the advisory report/) });
    expect(plan2.notes).toMatch(/Not mentioned in the report \(kept as they are; please confirm\):\n• HSBC Value Fund/);
  });

  it("only exact CAS names count, and only up to a quarter of the portfolio", () => {
    const loose = answerToReport({ ...base, cas_funds_not_in_report: ["HSBC Value Fund"] }, null);
    expect(buildPlanFromReport(loose, holdingsFromCas(cas), cas.valuationDate).problems).toHaveLength(1);
    // HDFC Defence (65% of the portfolio) not in the report: too big to keep without the advisor.
    const big = answerToReport({
      ...base, sells: [], sell_total: null, buys: [], buy_total: null,
      holds: [...base.holds, hold("HSBC Value Fund", 10475.67)],
      cas_funds_not_in_report: ["HDFC Defence Fund Direct Growth"],
    }, null);
    const p = buildPlanFromReport(big, holdingsFromCas(cas), cas.valuationDate).problems;
    expect(p).toEqual([expect.stringMatching(/HDFC Defence .* \d+% of the portfolio .* advisor must decide/)]);
  });

  it("never borrows the CAS name: a report with no printed name must be named after the client in its file name", async () => {
    const ask = vi.fn().mockResolvedValue(reply({ ...base, client_name: null, cas_funds_not_in_report: ["HSBC Value Fund - Direct Growth"] }));
    const args = { cas, reportPdf: new Uint8Array([1]), draft: null, readerError: null, problems: ["x"], deadline: far(), ask, maxRounds: 1 };
    const noName = await resolveWithClaude({ ...args, reportFileName: "report final.pdf" });
    expect(noName).toMatchObject({ status: "OPEN", problems: [expect.stringMatching(/report is for "unknown"/)] });
    expect((await resolveWithClaude({ ...args, reportFileName: "Advisory report - Test Investor.pdf" })).status).toBe("RESOLVED");
  });

  it("sends the points still open back to Claude with its own answer as the draft", async () => {
    const ask = vi.fn()
      .mockResolvedValueOnce(reply(base))
      .mockResolvedValueOnce(reply({ ...base, cas_funds_not_in_report: ["HSBC Value Fund - Direct Growth"], corrections: ["HSBC Value is not in the report."] }));
    const r = await resolveWithClaude({ cas, reportPdf: new Uint8Array([1]), draft: null, readerError: "unknown layout", problems: ["x"], deadline: far(), ask });
    expect(r.status).toBe("RESOLVED");
    expect(r.rounds).toBe(2);
    expect(r.corrections).toEqual(["Read the sell table.", "(round 2) HSBC Value is not in the report."]);
    const second = ask.mock.calls[1][0];
    expect(second.problems[0]).toMatch(/HSBC Value Fund .* not covered/);
    expect(second.draft.sells).toHaveLength(1);
    expect(second.readerError).toBeNull();
    if (r.status === "RESOLVED") expect(r.report.deploymentNotes.filter((n) => /Report read with Claude/.test(n))).toHaveLength(1);
  });

  it("stops after the last round or when time runs out, and keeps the open points", async () => {
    const ask = vi.fn().mockResolvedValue(reply(base));
    const r = await resolveWithClaude({ cas, reportPdf: new Uint8Array([1]), draft: null, readerError: null, problems: ["x"], deadline: far(), ask, maxRounds: 2 });
    expect(r).toMatchObject({ status: "OPEN", rounds: 2 });
    expect(ask).toHaveBeenCalledTimes(2);
    const late = await resolveWithClaude({ cas, reportPdf: new Uint8Array([1]), draft: null, readerError: null, problems: ["x"], deadline: Date.now() + 10_000, ask });
    expect(late).toMatchObject({ status: "OPEN", rounds: 0, problems: ["x"], error: expect.stringMatching(/time/) });
  });

  it("a Claude failure keeps the reader's points; a report for someone else is a wrong pair", async () => {
    const down = vi.fn().mockRejectedValue(new AppError("Could not reach the Claude reader (n8n) in time."));
    expect(await resolveWithClaude({ cas, reportPdf: new Uint8Array([1]), draft: null, readerError: null, problems: ["x"], deadline: far(), ask: down }))
      .toMatchObject({ status: "OPEN", problems: ["x"], error: expect.stringMatching(/in time/) });
    const other = vi.fn().mockResolvedValue(reply({ ...base, client_name: "Someone Else" }));
    expect((await resolveWithClaude({ cas, reportPdf: new Uint8Array([1]), draft: null, readerError: null, problems: ["x"], deadline: far(), ask: other })).status).toBe("WRONG_PAIR");
  });
});

describe("additional investment report (fresh money on top of the active plan)", () => {
  const topUp: ReportAiAnswer = {
    ...base, sells: [], sell_total: null, holds: [],
    buys: [
      { fund: "Parag Parikh Flexi Cap Fund", plan_type: "DIRECT", amount: 1000000, kind: "NEW", amc: null, category: null },
      { fund: "HDFC Defence Fund", plan_type: "DIRECT", amount: 500000, kind: "TOP_UP", amc: null, category: null },
    ],
    buy_total: 1500000, report_kind: null, fresh_money: 1500000,
  };

  it("needs only its own lines to tie to the CAS; buys minus sells must equal the fresh money", () => {
    const r = answerToReport(topUp, null);
    expect(buildPlanFromReport(r, holdingsFromCas(cas), cas.valuationDate).problems.length).toBeGreaterThan(0); // as a full report: holdings not covered
    const add = buildPlanFromReport(r, holdingsFromCas(cas), cas.valuationDate, { additional: true });
    expect(add.problems).toEqual([]);
    expect(add).toMatchObject({ plan_kind: "ADDITIONAL", fresh_money: 1500000 });
    expect(add.items.map((i) => i.action)).toEqual(["BUY", "BUY"]); // no RETAIN lines: the active plan has them
    const off = buildPlanFromReport({ ...r, freshMoney: 2000000 }, holdingsFromCas(cas), cas.valuationDate, { additional: true });
    expect(off.problems[0]).toMatch(/₹20,00,000 of fresh money.*₹15,00,000/);
  });

  it("AUTO picks additional only for a client with an active plan", () => {
    const r = answerToReport(topUp, null);
    expect(decideReportKind(cas, r, { choice: "AUTO", hasActivePlan: true })).toMatchObject({ kind: "ADDITIONAL", problems: [] });
    expect(decideReportKind(cas, r, { choice: "AUTO", hasActivePlan: false }).kind).toBe("FULL");
    expect(decideReportKind(cas, r, { choice: "ADDITIONAL", hasActivePlan: false }).problems[0]).toMatch(/no active plan/);
    // A full report that ties out stays a full rebalancing even for an existing client.
    const full = answerToReport({ ...base, cas_funds_not_in_report: ["HSBC Value Fund - Direct Growth"] }, null);
    expect(decideReportKind(cas, full, { choice: "AUTO", hasActivePlan: true }).kind).toBe("FULL");
    // Claude says it is an additional investment.
    const said = answerToReport({ ...topUp, report_kind: "ADDITIONAL_INVESTMENT" }, null);
    expect(said.reportKind).toBe("ADDITIONAL");
    expect(decideReportKind(cas, said, { choice: "AUTO", hasActivePlan: true }).kind).toBe("ADDITIONAL");
  });
});

describe("Migrate to Direct", () => {
  it("a Regular holding the report migrates becomes a MIGRATE line to the Direct plan; an already-Direct one stays Keep", () => {
    const hs = holdingsFromCas(cas).map((h) => (/360 ONE/.test(h.scheme_name) ? { ...h, scheme_name: "360 ONE Flexicap Fund Regular Plan Growth", plan_type: "REGULAR" as const } : h));
    const a: ReportAiAnswer = {
      ...base,
      holds: base.holds.map((h, i) => (i < 2 ? { ...h, note: "MIGRATE TO DIRECT; Hold", plan_type: i === 0 ? null : h.plan_type } : h)),
      cas_funds_not_in_report: ["HSBC Value Fund - Direct Growth"],
    };
    const plan = buildPlanFromReport(answerToReport(a, null), hs, cas.valuationDate);
    expect(plan.problems).toEqual([]);
    const mig = plan.items.filter((i) => i.action === "MIGRATE");
    expect(mig).toHaveLength(1);
    expect(mig[0]).toMatchObject({ scheme_name: expect.stringMatching(/360 ONE .*Regular/), switch_to_scheme_name: "360 ONE Flexicap Fund (Direct)", target_amount: 31823.12 });
    expect(mig[0].reason).toMatch(/^MIGRATE TO DIRECT; Hold/);
    // The Consumption fund is already Direct: nothing to migrate.
    expect(plan.items.find((i) => /Consumption/.test(i.scheme_name))?.action).toBe("RETAIN");
    // Not part of the sell / buy totals.
    expect(plan.declared_totals.exit_value).toBe(227651.49);
  });
});
