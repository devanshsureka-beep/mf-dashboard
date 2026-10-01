import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { answerToReport, type ReportAiAnswer } from "@/lib/integrations/report-ai";
import { buildPlanFromReport } from "@/lib/domain/report-plan";
import { parseCasLines } from "@/lib/parsers/cas";
import { holdingsFromCas } from "@/services/onboarding";
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
