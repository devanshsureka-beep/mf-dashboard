import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { categorise, documentChecks } from "@/lib/domain/document-checks";
import { buildPlanFromReport, type PlanHolding } from "@/lib/domain/report-plan";
import { parseAdvisoryReportLines } from "@/lib/parsers/advisory-report";
import type { CasParseOutput } from "@/lib/parsers/cas";

const lines = readFileSync("tests/fixtures/univest-report-2.sample.txt", "utf8").split("\n");
const report = parseAdvisoryReportLines(lines);
const funds: [string, string, string, number][] = [
  ["DSP Small Cap Fund - Direct Plan - Growth", "INF740K01QD1", "70000006/35", 569399.04],
  ["HDFC Large Cap Fund - Regular Plan - Growth", "INF179K01BE2", "70000005/73", 1037894.75],
  ["ICICI Prudential Nifty Next 50 Index Fund - Direct Plan - Growth", "INF109K01Y80", "70000004/71", 246455.47],
  ["ICICI Prudential Nifty Alpha Low-Volatility 30 ETF FOF Direct Plan Growth", "INF109KC1R89", "70000004/71", 370300.7],
  ["Invesco India Mid Cap Fund - Direct Plan Growth", "INF205K01MV6", "70000010/0", 5040.04],
  ["Kotak Mid Cap Fund Direct Growth", "INF174K01LT0", "70000007", 465736.74],
  ["Mirae Asset Large and Midcap Fund - Regular Plan", "INF769K01101", "70000008/0", 1674437.55],
  ["Nippon India Small Cap Fund - Direct Growth", "INF204K01K15", "70000009/0", 336522.94],
  ["Parag Parikh Flexi Cap Fund - Direct Plan Growth", "INF879O01027", "70000003", 417074.33],
  ["SBI Large Cap Fund - Regular Plan - Growth", "INF200K01180", "70000001", 1729976.66],
  ["UTI Nifty 50 Index Fund - Direct Plan", "INF789F01XA0", "70000002/0", 562205.97],
];
const cas = {
  format: "KFIN_CAMS_CONSOLIDATED", source: "CAMS",
  investor: { name: "Sample Client", email: null, mobile: null, pan: "ABCPS4321Q" },
  period: { from: null, to: null }, valuationDate: "2026-09-23", summaryTotal: { cost: null, market: null },
  schemes: funds.map(([schemeName, isin, folio, marketValue]) => ({
    amc: null, schemeName, rawSchemeLine: schemeName, isin, folio, pan: "ABCPS4321Q", registrar: null, holderName: null,
    planType: null, closingUnits: 1, nav: marketValue, navDate: null, marketValue, costValue: null, transactions: [],
  })),
  warnings: [],
} as CasParseOutput;
const holdings: PlanHolding[] = funds.map(([scheme_name, isin, folio_number, current_value]) => ({ scheme_name, isin, folio_number, current_value }));

describe("Check documents checklist", () => {
  it("all checks pass for a report and the CAS it was made from", () => {
    const draft = buildPlanFromReport(report, holdings, "2026-09-23");
    const checks = documentChecks({ cas, report, draft, problems: draft.problems });
    expect(checks.map((c) => [c.id, c.status])).toEqual([
      ["investor", "PASS"], ["statement", "PASS"], ["cas", "PASS"], ["sells", "PASS"],
      ["review", "PASS"], ["coverage", "PASS"], ["buys", "PASS"], ["sips", "PASS"],
    ]);
    expect(checks.find((c) => c.id === "sips")?.detail).toMatch(/9 start, 8 stop, 1 change/);
  });

  it("each kind of mistake lands in its own named check (never 'other')", () => {
    const tampered = [
      lines.filter((l) => !l.startsWith("HDFC Large Cap Fund (Reg) | 70000005")),
      lines.map((l) => l.replace("Bandhan Small Cap Fund | — | 15,000 | New", "Bandhan Small Cap Fund | — | 16,000 | New")),
      lines.filter((l) => !l.startsWith("DSP India T.I.G.E.R. Fund | ₹3,50,000")),
    ];
    const problems = tampered.flatMap((t) => buildPlanFromReport(parseAdvisoryReportLines(t), holdings, "2026-09-23").problems);
    const off = buildPlanFromReport(report, holdings.map((h) => (h.isin === "INF200K01180" ? { ...h, current_value: 1600000 } : h)), "2026-09-23").problems;
    const missing = buildPlanFromReport(report, [...holdings, { scheme_name: "SBI Liquid Fund - Direct", isin: "INF200K01ZZ1", folio_number: "1", current_value: 1000 }], "2026-09-23").problems;
    const all = [...problems, ...off, ...missing, ...buildPlanFromReport(report, holdings, "2026-09-30").problems];
    expect(all.length).toBeGreaterThan(5);
    expect(all.filter((p) => categorise(p) === "other")).toEqual([]);
    expect(categorise(missing.find((p) => /not covered/.test(p))!)).toBe("coverage");
    const failed = documentChecks({ cas, report, draft: buildPlanFromReport(report, holdings, "2026-09-23"), problems: off });
    expect(failed.filter((c) => c.status === "FAIL").map((c) => c.id)).toEqual(expect.arrayContaining(["sells"]));
  });
});
