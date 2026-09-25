import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAdvisoryReportLines } from "@/lib/parsers/advisory-report";
import { buildPlanFromReport, matchHolding, withPlanType, type PlanHolding } from "@/lib/domain/report-plan";

const report = parseAdvisoryReportLines(readFileSync("tests/fixtures/univest-report.sample.txt", "utf8").split("\n"));

// CAS-style names for the report's holdings (registrar wording differs from the report's).
const holdings: PlanHolding[] = [
  { scheme_name: "Axis Gold and Silver Passive Fund of Fund - Regular Growth", isin: "INF846K01A01", folio_number: "9000/0", current_value: 437226 },
  { scheme_name: "Bandhan Gold ETF Fund of Fund - Regular Plan - Growth", isin: "INF194K01A02", folio_number: "9001/1", current_value: 246248 },
  { scheme_name: "Nippon India Silver ETF Fund of Fund (FOF) - Regular Plan - Growth", isin: "INF204K01A03", folio_number: "9002/2", current_value: 202538 },
  { scheme_name: "Mahindra Manulife Multi Cap Fund - Regular Plan - Growth", isin: "INF174V01A04", folio_number: "9003/3", current_value: 189295 },
  { scheme_name: "Bandhan Silver ETF FoF - Regular Plan - Growth", isin: "INF194K01A05", folio_number: "9004/4", current_value: 188225 },
  { scheme_name: "PGIM India Flexi Cap Fund - Regular Plan - Growth", isin: "INF663L01A06", folio_number: "9005/5", current_value: 158846 },
  { scheme_name: "Mirae Asset Gold Silver Passive FoF - Regular Plan - Growth", isin: "INF769K01A07", folio_number: "9006/6", current_value: 137139 },
  { scheme_name: "Nippon India Silver ETF Fund of Fund (FOF) - Regular Plan - Growth", isin: "INF204K01A03", folio_number: "9007/7", current_value: 17240 },
  { scheme_name: "HDFC Flexi Cap Fund - Regular Plan - Growth", isin: "INF179K01A09", folio_number: "9008/8", current_value: 899 },
];

describe("advisory report -> plan items", () => {
  const plan = buildPlanFromReport(report, holdings, "2026-09-23");

  it("ties every sell line to its CAS holding by folio (same fund in two folios stays separate)", () => {
    const sells = plan.items.filter((i) => i.action === "SELL" || i.action === "SWITCH");
    expect(sells).toHaveLength(9);
    expect(sells.every((s) => s.isin)).toBe(true);
    const nippon = sells.filter((s) => s.isin === "INF204K01A03").map((s) => [s.folio_number, s.target_amount]);
    expect(nippon).toEqual([["9002/2", 202538], ["9007/7", 17240]]);
    expect(sells.find((s) => s.folio_number === "9003/3")?.action).toBe("SWITCH");
    expect(plan.problems).toEqual([]);
  });

  it("a CAS holding the report does not cover is a problem, not a silent RETAIN", () => {
    const extra = [...holdings, { scheme_name: "SBI Liquid Fund - Direct Growth", isin: "INF200K01A10", folio_number: "5555", current_value: 1000 }];
    const p = buildPlanFromReport(report, extra, "2026-09-23");
    expect(p.problems.some((x) => /SBI Liquid Fund .* not covered by the report/.test(x))).toBe(true);
  });

  it("creates BUY items with plan type in the name and the declared totals", () => {
    const buys = plan.items.filter((i) => i.action === "BUY");
    expect(buys).toHaveLength(8);
    expect(buys[0].scheme_name).toBe("Nippon India Multi Asset Allocation Fund (Direct)");
    const sum = buys.reduce((t, b) => t + b.target_amount, 0);
    expect(Math.abs(sum - (plan.declared_totals.buy_value ?? 0))).toBeLessThan(2);
    expect(plan.plan_date).toBe("2026-09-24");
  });

  it("creates SIP start/stop items; stops carry the held fund's ISIN", () => {
    expect(plan.sip_items.length).toBeGreaterThan(0);
    const stops = plan.sip_items.filter((s) => s.action === "STOP");
    const starts = plan.sip_items.filter((s) => s.action === "START");
    expect(starts.every((s) => (s.new_amount ?? 0) > 0 && s.old_amount === null)).toBe(true);
    expect(stops.every((s) => (s.old_amount ?? 0) > 0)).toBe(true);
    const startTotal = starts.reduce((t, s) => t + (s.new_amount ?? 0), 0);
    expect(startTotal).toBe(report.sipTotals.next);
  });

  it("does not guess: unknown folio + unclear name is not matched", () => {
    expect(matchHolding("Some Other Fund", "12345678", holdings)).toBeNull();
    expect(withPlanType("HDFC Flexi Cap Fund", "DIRECT")).toBe("HDFC Flexi Cap Fund (Direct)");
    expect(withPlanType("HDFC Flexi Cap Fund - Direct Plan", "DIRECT")).toBe("HDFC Flexi Cap Fund - Direct Plan");
  });
});

// Second layout (masked): partial trim, holds, a top-up of a held fund, SIP change/stops.
const report2 = parseAdvisoryReportLines(readFileSync("tests/fixtures/univest-report-2.sample.txt", "utf8").split("\n"));
const holdings2: PlanHolding[] = [
  { scheme_name: "DSP Small Cap Fund - Direct Plan - Growth", isin: "INF740K01QD1", folio_number: "70000006/35", current_value: 569399.04, plan_type: "DIRECT" },
  { scheme_name: "HDFC Large Cap Fund - Regular Plan - Growth", isin: "INF179K01BE2", folio_number: "70000005/73", current_value: 1037894.75, plan_type: "REGULAR" },
  { scheme_name: "ICICI Prudential Nifty Next 50 Index Fund - Direct Plan - Growth", isin: "INF109K01Y80", folio_number: "70000004/71", current_value: 246455.47, plan_type: "DIRECT" },
  { scheme_name: "ICICI Prudential Nifty Alpha Low-Volatility 30 ETF FOF Direct Plan Growth", isin: "INF109KC1R89", folio_number: "70000004/71", current_value: 370300.7, plan_type: "DIRECT" },
  { scheme_name: "Invesco India Mid Cap Fund - Direct Plan Growth", isin: "INF205K01MV6", folio_number: "70000010/0", current_value: 5040.04, plan_type: "DIRECT" },
  { scheme_name: "Kotak Mid Cap Fund Direct Growth", isin: "INF174K01LT0", folio_number: "70000007", current_value: 465736.74, plan_type: "DIRECT" },
  { scheme_name: "Mirae Asset Large and Midcap Fund - Regular Plan", isin: "INF769K01101", folio_number: "70000008/0", current_value: 1674437.55, plan_type: "REGULAR" },
  { scheme_name: "NIPPON INDIA SMALL CAP FUND - DIRECT GROWTH PLAN GROWTH OPTION", isin: "INF204K01K15", folio_number: "70000009/0", current_value: 336522.94, plan_type: "DIRECT" },
  { scheme_name: "Parag Parikh Flexi Cap Fund - Direct Plan Growth", isin: "INF879O01027", folio_number: "70000003", current_value: 417074.33, plan_type: "DIRECT" },
  { scheme_name: "SBI Large Cap Fund - Regular Plan - Growth", isin: "INF200K01180", folio_number: "70000001", current_value: 1729976.66, plan_type: "REGULAR" },
  { scheme_name: "UTI Nifty 50 Index Fund - Direct Plan", isin: "INF789F01XA0", folio_number: "70000002/0", current_value: 562205.97, plan_type: "DIRECT" },
];

describe("advisory report (second layout) -> plan items, checked against the CAS", () => {
  const plan = buildPlanFromReport(report2, holdings2, "2026-09-23");

  it("builds the whole plan with nothing left to doubt", () => {
    expect(plan.problems).toEqual([]);
    const by = (a: string) => plan.items.filter((i) => i.action === a);
    expect(by("SELL")).toHaveLength(6);
    expect(by("RETAIN")).toHaveLength(5);
    expect(by("BUY")).toHaveLength(9);
    expect(plan.sip_items).toHaveLength(18);
  });

  it("the partial trim sells only the trimmed amount from the right folio", () => {
    expect(plan.items.find((i) => i.isin === "INF179K01BE2")).toMatchObject({ action: "SELL", target_amount: 500000, current_amount: 1037894.75, folio_number: "70000005/73" });
  });

  it("a top-up and a new SIP in a held fund use that fund; other new SIPs use the Direct fund being bought", () => {
    expect(plan.items.find((i) => i.action === "BUY" && /Invesco/.test(i.scheme_name))?.isin).toBe("INF205K01MV6");
    expect(plan.sip_items.find((s) => s.action === "START" && /Invesco/.test(s.scheme_name))?.isin).toBe("INF205K01MV6");
    const edelSip = plan.sip_items.find((s) => /Edelweiss/.test(s.scheme_name))!;
    const edelBuy = plan.items.find((i) => i.action === "BUY" && /Edelweiss/.test(i.scheme_name))!;
    expect(edelSip.scheme_name).toBe(edelBuy.scheme_name);
    expect(edelSip.scheme_name).toMatch(/\(Direct\)$/);
    expect(plan.sip_items.filter((s) => s.action !== "START").every((s) => s.isin)).toBe(true);
  });

  it("refuses when the CAS does not back up the report", () => {
    const valueOff = holdings2.map((h) => (h.isin === "INF200K01180" ? { ...h, current_value: 1600000 } : h));
    expect(buildPlanFromReport(report2, valueOff, "2026-09-23").problems.some((x) => /SBI Large Cap .*1,600,000|16,00,000/.test(x))).toBe(true);

    const missing = holdings2.filter((h) => h.isin !== "INF789F01XA0");
    const pm = buildPlanFromReport(report2, missing, "2026-09-23").problems;
    expect(pm.some((x) => /UTI Nifty 50 .* does not match any fund in the CAS/.test(x))).toBe(true);

    expect(buildPlanFromReport(report2, holdings2, "2026-09-30").problems[0]).toMatch(/Upload the same CAS/);

    // Direct and Regular never mix: a Regular-only holding does not satisfy a Direct top-up.
    const regular = holdings2.map((h) => (h.isin === "INF205K01MV6" ? { ...h, scheme_name: "Invesco India Mid Cap Fund - Regular Plan Growth", plan_type: "REGULAR" as const } : h));
    expect(buildPlanFromReport(report2, regular, "2026-09-23").problems.some((x) => /top-up/.test(x))).toBe(true);
  });
});
