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
  { scheme_name: "SBI Liquid Fund - Direct Growth", isin: "INF200K01A10", folio_number: "5555", current_value: 1000 },
];

describe("advisory report -> plan items", () => {
  const plan = buildPlanFromReport(report, holdings);

  it("ties every sell line to its CAS holding by folio (same fund in two folios stays separate)", () => {
    const sells = plan.items.filter((i) => i.action === "SELL" || i.action === "SWITCH");
    expect(sells).toHaveLength(9);
    expect(sells.every((s) => s.isin)).toBe(true);
    const nippon = sells.filter((s) => s.isin === "INF204K01A03").map((s) => [s.folio_number, s.target_amount]);
    expect(nippon).toEqual([["9002/2", 202538], ["9007/7", 17240]]);
    expect(sells.find((s) => s.folio_number === "9003/3")?.action).toBe("SWITCH");
    expect(plan.warnings).toEqual([]);
  });

  it("keeps holdings the report does not touch as RETAIN", () => {
    const retain = plan.items.filter((i) => i.action === "RETAIN");
    expect(retain.map((r) => r.folio_number)).toEqual(["5555"]);
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
