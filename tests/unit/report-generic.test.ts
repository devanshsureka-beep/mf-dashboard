import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PdfPage } from "@/lib/pdf/text";
import { parseAdvisoryReportPages } from "@/lib/parsers/report";
import { parseFundCell } from "@/lib/parsers/report-generic";
import { buildPlanFromReport, type PlanHolding } from "@/lib/domain/report-plan";

// A different report layout (masked): "Rs." amounts, Western digit grouping, wrapped
// fund names, "(folio …)" and "(x2 folios)" in fund names, a two-phase plan.
const pages = JSON.parse(readFileSync("tests/fixtures/report-generic-3.sample.json", "utf8")) as PdfPage[];
const report = parseAdvisoryReportPages(pages);

// The CAS this report was made from (values as printed in the report; kept funds with plausible values).
const H = (scheme_name: string, isin: string, folio_number: string, current_value: number, plan_type: "DIRECT" | "REGULAR"): PlanHolding => ({ scheme_name, isin, folio_number, current_value, plan_type });
const holdings: PlanHolding[] = [
  H("HDFC Balanced Advantage Fund - Regular Plan - Growth", "INF179K01830", "81000001/12", 64670.2, "REGULAR"),
  H("HDFC Balanced Advantage Fund - Direct Plan - Growth", "INF179K01WA6", "81000002/31", 137308.4, "DIRECT"),
  H("HDFC Balanced Advantage Fund - Regular Plan - Growth", "INF179K01830", "81000005/44", 285895.1, "REGULAR"),
  H("ICICI Prudential Balanced Advantage Fund - Growth", "INF109K01BH2", "5001001/11", 109168.3, "REGULAR"),
  H("ICICI Prudential Equity & Debt Fund - Direct Plan - Growth", "INF109K01Y07", "5001001/11", 140812.0, "DIRECT"),
  H("Quant Multi Asset Allocation Fund - Growth Option - Direct Plan", "INF966L01986", "7001001", 157430.0, "DIRECT"),
  H("Quant Large and Mid Cap Fund - Growth Option - Direct Plan", "INF966L01671", "7001001", 137052.0, "DIRECT"),
  H("SBI Contra Fund - Regular Plan - Growth", "INF200K01388", "6001001", 35111.0, "REGULAR"),
  H("SBI Large Cap Fund - Regular Plan - Growth", "INF200K01180", "6001001", 41111.0, "REGULAR"),
  H("Mirae Asset Large Cap Fund - Regular Plan - Growth", "INF769K01010", "7771001", 100502.0, "REGULAR"),
  H("Nippon India Small Cap Fund - Growth Plan - Growth Option", "INF204K01HY3", "4001001/01", 72334.0, "REGULAR"),
  H("Nippon India Small Cap Fund - Direct Plan Growth Plan - Growth Option", "INF204K01K15", "4001001/02", 310000.0, "DIRECT"),
  H("Kotak Flexicap Fund - Regular Plan - Growth", "INF174K01336", "81000003", 63624.0, "REGULAR"),
  H("Kotak Flexicap Fund - Regular Plan - Growth", "INF174K01336", "81000004", 252808.0, "REGULAR"),
  H("Aditya Birla Sun Life Digital India Fund - Regular Growth", "INF209K01BR9", "1041001", 31000.0, "REGULAR"),
  H("Aditya Birla Sun Life Digital India Fund - Regular Growth", "INF209K01BR9", "1041002", 20495.0, "REGULAR"),
  H("Parag Parikh Flexi Cap Fund - Direct Plan Growth", "INF879O01027", "1471001", 135769.0, "DIRECT"),
  H("Axis Midcap Fund - Regular Growth", "INF846K01859", "9101001", 127958.0, "REGULAR"),
  H("HSBC Midcap Fund - Regular Growth", "INF917K01254", "81000006", 208364.0, "REGULAR"),
  H("HSBC Midcap Fund - Regular Growth", "INF917K01254", "81000007", 85187.0, "REGULAR"),
  H("Motilal Oswal Flexi Cap Fund - Regular Plan Growth", "INF247L01411", "9201001", 254413.0, "REGULAR"),
  H("Aditya Birla Sun Life PSU Equity Fund - Direct Growth", "INF209KB1Z58", "1041003", 90000.0, "DIRECT"),
  H("ICICI Prudential Infrastructure Fund - Direct Plan - Growth", "INF109K01AV5", "5001002", 80000.0, "DIRECT"),
  H("Motilal Oswal Midcap Fund - Direct Plan Growth", "INF247L01445", "9201002", 85269.0, "DIRECT"),
  H("WhiteOak Capital Mid Cap Fund - Direct Plan Growth", "INF03VN01860", "9301001", 15000.0, "DIRECT"),
];

describe("advisory report in another layout", () => {
  it("is read by the layout-independent reader and every printed total reconciles", () => {
    expect(report.template).toBe("GENERIC_TABLES");
    expect(report.problems).toEqual([]);
    expect(report.clientName).toBe("Sample Client Three");
    expect(report.sells).toHaveLength(14);
    expect(report.sellTotal).toBe(1499194);
    expect(report.holds.map((h) => h.value)).toEqual([285895, 127958, 208364, 85187, 254413]);
    expect(report.buys.map((b) => [b.amount, b.kind])).toEqual([[400000, "NEW"], [523295, "NEW"], [200000, "TOP_UP"], [200000, "NEW"], [150000, "NEW"]]);
    expect(report.buyTotal).toBe(1473295);
    expect(report.sips.filter((s) => s.change === "STOP")).toHaveLength(6);
    expect(report.sips.filter((s) => s.change === "START").map((s) => s.next)).toEqual([9000, 13000, 4000, 4000]);
    expect(report.sipTotals).toEqual({ current: 45000, next: 45000 });
  });

  it("reassembles fund names that wrap across lines", () => {
    expect(report.buys.find((b) => b.amount === 150000)?.fund).toBe("ICICI Prudential Large & Mid Cap Fund (Direct)");
    expect(report.sips.find((s) => /Aggressive Hybrid/.test(s.fund))?.fund).toBe("ICICI Prudential Aggressive Hybrid Fund (Direct)");
  });

  it("reads folios, multi-folio rows, top-ups and plan types from fund names", () => {
    expect(parseFundCell("HDFC Balanced Advantage Fund - Regular (folio 19970693)")).toMatchObject({ name: "HDFC Balanced Advantage Fund", planType: "REGULAR", folio: "19970693", folioCount: 1 });
    expect(parseFundCell("Aditya Birla SL Digital India Fund - Regular (x2 folios)")).toMatchObject({ folioCount: 2, planType: "REGULAR" });
    expect(parseFundCell("Nippon India Small Cap Fund - Direct (top-up)")).toMatchObject({ topUp: true, planType: "DIRECT" });
    expect(parseFundCell("Axis Midcap Fund - Regular to Direct (switch)")).toMatchObject({ name: "Axis Midcap Fund", planType: "REGULAR" });
  });

  it("ties every line to the CAS: sells, multi-folio sells, deferred holds, kept funds", () => {
    const plan = buildPlanFromReport(report, holdings, null);
    expect(plan.problems).toEqual([]);
    const sells = plan.items.filter((i) => i.action === "SELL");
    expect(sells).toHaveLength(15); // 14 rows, one of them two folios
    expect(sells.filter((i) => /Digital India/.test(i.scheme_name)).map((i) => i.target_amount)).toEqual([31000, 20495]);
    expect(sells.find((i) => i.folio_number === "81000001/12")?.target_amount).toBe(64670); // the right HDFC folio
    const retain = plan.items.filter((i) => i.action === "RETAIN");
    expect(retain).toHaveLength(10);
    expect(retain.find((i) => i.folio_number === "81000005/44")?.reason).toMatch(/Kept for now/);
    expect(plan.items.find((i) => i.action === "BUY" && /Nippon/.test(i.scheme_name))?.isin).toBe("INF204K01K15"); // top-up of the Direct fund
    expect(plan.sip_items.filter((s) => s.action === "STOP").every((s) => s.isin)).toBe(true);
  });

  it("refuses when the CAS and the report disagree", () => {
    const valueOff = holdings.map((h) => (h.folio_number === "81000004" ? { ...h, current_value: 240000 } : h));
    expect(buildPlanFromReport(report, valueOff, null).problems.some((p) => /Kotak Flexicap .*full exit/.test(p))).toBe(true);
    const extra = [...holdings, H("Some Other Fund - Direct Growth", "INF000000011", "1", 5000, "DIRECT")];
    expect(buildPlanFromReport(report, extra, null).problems.some((p) => /Some Other Fund .* not covered/.test(p))).toBe(true);
    const oneFolio = holdings.filter((h) => h.folio_number !== "1041002");
    expect(buildPlanFromReport(report, oneFolio, null).problems.some((p) => /covers 2 folios/.test(p))).toBe(true);
    const holdOff = holdings.map((h) => (h.folio_number === "81000006" ? { ...h, current_value: 150000 } : h));
    expect(buildPlanFromReport(report, holdOff, null).problems.some((p) => /HSBC Midcap .*report values it at/.test(p))).toBe(true);
  });

  it("a dropped row or altered amount is caught by the printed totals", () => {
    const drop = pages.map((p) => ({ ...p, items: p.items.filter((i) => !/^Mirae Asset Large Cap Fund - Regular$/.test(i.s) && !(p.page === 2 && /^100,502$/.test(i.s))) }));
    expect(parseAdvisoryReportPages(drop).problems.some((x) => /Sell rows add up/.test(x))).toBe(true);
    const alter = pages.map((p) => ({ ...p, items: p.items.map((i) => (p.page === 6 && i.s === "13,000" ? { ...i, s: "14,000" } : i)) }));
    expect(parseAdvisoryReportPages(alter).problems.some((x) => /New SIP rows add up/.test(x))).toBe(true);
  });
});
