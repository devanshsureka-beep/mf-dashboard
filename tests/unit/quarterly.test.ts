import { describe, expect, it } from "vitest";
import {
  addMonths, fifo, fyGains, fyOf, lineStatus, lotsTurningLong, navOn, nextReviewLabel, pctChange, projectValue,
  quarterEndOnOrBefore, quarterLabel, reconciles, replay, scanForbidden, taxClassOf, xirr, yearsToReach,
} from "@/lib/domain/quarterly";

const S = [
  { date: "2026-04-01", nav: 100 },
  { date: "2026-04-02", nav: 102 },
  { date: "2026-06-30", nav: 110 },
  { date: "2026-10-09", nav: 120 },
];

describe("quarterly review arithmetic", () => {
  it("takes the NAV on or before a date, and none before the series", () => {
    expect(navOn(S, "2026-04-01")).toBe(100);
    expect(navOn(S, "2026-04-05")).toBe(102); // holiday: previous NAV
    expect(navOn(S, "2026-12-31")).toBe(120);
    expect(navOn(S, "2026-03-29")).toBe(100); // within the grace days
    expect(navOn(S, "2026-01-01")).toBeNull();
    expect(navOn([], "2026-04-01")).toBeNull();
    expect(pctChange(S, "2026-04-01", "2026-10-09")).toBeCloseTo(0.2);
  });

  it("replays the same rupees on the same dates", () => {
    // ₹1,000 at 100 (10 units) + ₹1,100 at 110 (10 units) − ₹600 at 120 (5 units) = 15 units × 120.
    expect(replay([{ date: "2026-04-01", amount: 1000 }, { date: "2026-06-30", amount: 1100 }, { date: "2026-10-09", amount: -600 }], S, "2026-10-09"))
      .toEqual({ invested: 1500, value: 1800 });
    expect(replay([{ date: "2025-01-01", amount: 1000 }], S, "2026-10-09")).toBeNull();
  });

  it("finds the XIRR, and none for one-sided flows", () => {
    // ₹100 grows to ₹110 in exactly a year: 10%.
    expect(xirr([{ date: "2025-01-01", amount: -100 }, { date: "2026-01-01", amount: 110 }])!).toBeCloseTo(0.1, 4);
    expect(xirr([{ date: "2025-01-01", amount: -100 }])).toBeNull();
  });

  it("sells the oldest units first and splits long- and short-term gains", () => {
    const { lots, realised } = fifo([
      { date: "2024-05-01", units: 10, amount: 1000 },
      { date: "2025-09-01", units: 10, amount: 1500 },
      { date: "2026-06-01", units: -15, amount: -3000 },
    ], "EQUITY");
    expect(realised).toEqual([
      { date: "2026-06-01", units: 10, proceeds: 2000, cost: 1000, gain: 1000, term: "LT" },
      { date: "2026-06-01", units: 5, proceeds: 1000, cost: 750, gain: 250, term: "ST" },
    ]);
    expect(lots).toEqual([{ date: "2025-09-01", units: 5, costPerUnit: 150 }]);
    expect(lotsTurningLong(lots, "EQUITY", "2026-06-01", "2026-12-31")).toEqual([{ date: "2026-09-02", units: 5 }]);
  });

  it("marks units from before the CAS history as unknown", () => {
    const { realised } = fifo([{ date: "2026-05-01", units: -4, amount: -400 }], "EQUITY", 3);
    expect(realised[0]).toMatchObject({ units: 3, term: "UNKNOWN", gain: null });
    expect(realised).toHaveLength(1);
  });

  it("adds up the FY's gains with one ₹1.25L exemption across funds", () => {
    const fy = fyOf("2026-10-12");
    expect(fy).toEqual({ start: "2026-04-01", end: "2027-03-31", label: "FY27" });
    const g = fyGains([
      { date: "2026-05-01", units: 1, proceeds: 0, cost: 0, gain: 100000, term: "LT", cls: "EQUITY" },
      { date: "2026-06-01", units: 1, proceeds: 0, cost: 0, gain: 75000, term: "LT", cls: "EQUITY" },
      { date: "2026-07-01", units: 1, proceeds: 0, cost: 0, gain: 10000, term: "ST", cls: "EQUITY" },
      { date: "2026-07-01", units: 1, proceeds: 500, cost: null, gain: null, term: "UNKNOWN", cls: "EQUITY" },
      { date: "2026-02-01", units: 1, proceeds: 0, cost: 0, gain: 99999, term: "LT", cls: "EQUITY" },
    ], fy);
    expect(g).toMatchObject({ equityLt: 175000, equitySt: 10000, exemptionLeft: 0, unknownProceeds: 500 });
    expect(g.estTax).toBeCloseTo(50000 * 0.125 + 10000 * 0.2);
  });

  it("knows how each kind of fund is taxed", () => {
    expect(taxClassOf("Equity", "Equity Scheme - Mid Cap Fund", "X Mid Cap")).toBe("EQUITY");
    expect(taxClassOf("Hybrid", "Hybrid Scheme - Dynamic Asset Allocation or Balanced Advantage", "X BAF")).toBe("EQUITY");
    expect(taxClassOf("Debt", "Debt Scheme - Liquid Fund", "X Liquid")).toBe("SLAB");
    expect(taxClassOf("Gold & silver", "Other Scheme - FoF Domestic", "X Gold Fund")).toBe("LONG24");
  });

  it("projects today's value plus the SIP", () => {
    expect(projectValue(100000, 0, 0.12, 1)).toBeCloseTo(112000, 0);
    expect(projectValue(0, 1000, 0, 1)).toBe(12000);
    // The example's base path: ₹6.88L + ₹30K a month at 14% crosses ₹1 Cr in about 11 years.
    expect(yearsToReach(1e7, 688130, 30000, 0.14)).toBeGreaterThan(10);
    expect(yearsToReach(1e7, 688130, 30000, 0.14)).toBeLessThan(12);
  });

  it("dates a review", () => {
    expect(quarterEndOnOrBefore("2026-10-12")).toBe("2026-09-30");
    expect(quarterEndOnOrBefore("2026-01-05")).toBe("2025-12-31");
    expect(quarterLabel("2026-09-30")).toBe("Jul–Sep 2026");
    expect(nextReviewLabel("2026-09-30")).toBe("Mid-January 2027");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
  });

  it("names each plan line's status", () => {
    expect(lineStatus(100000, 100000, 0)).toBe("DONE");
    expect(lineStatus(100000, 40000, 60000)).toBe("CONFIRM");
    expect(lineStatus(100000, 40000, 0)).toBe("PARTLY");
    expect(lineStatus(100000, 0, 0)).toBe("NOT DONE");
  });

  it("finds internal model names and other clients' names", () => {
    expect(scanForbidden("Passed the MF Bomb gate 3 check", [])).toEqual(["MF Bomb", "gate number"]);
    expect(scanForbidden("Moonshot 18.7% is a scenario; Nifty 50 G-sec", ["Asha Rao", "Ravi"])).toEqual([]);
    expect(scanForbidden("Sold for ASHA  RAO last year", ["Asha Rao"])).toEqual(["another client's name (Asha Rao)"]);
    expect(reconciles([10, 20, 30], 60)).toBe(true);
    expect(reconciles([10, 20, 30], 70)).toBe(false);
  });
});

import { inputsFromEntries, QuarterlyInputs } from "@/lib/domain/quarterly-inputs";

describe("quarterly review form", () => {
  it("turns dotted fields into inputs and leaves blanks out", () => {
    const raw = inputsFromEntries([
      ["headline", "  A good quarter "], ["tagline", ""], ["$ACTION_ID", "x"], ["index.INF000", "NIFTY50"],
      ["funds.k1.status", "AMBER"], ["funds.k1.why", "Watch it"], ["funds.k2.status", ""],
      ["story.1.title", "Building"], ["actions.0.title", "Register the SIP"], ["actions.0.when", "This week"],
      ["rates.base", "12"], ["exitLoad", "80"],
    ]);
    const parsed = QuarterlyInputs.parse(raw);
    expect(parsed).toEqual({
      headline: "A good quarter",
      funds: { k1: { status: "AMBER", why: "Watch it" } },
      story: [{ when: "", title: "", text: "" }, { when: "", title: "Building", text: "" }],
      actions: [{ title: "Register the SIP", detail: "", when: "This week" }],
      rates: { bear: 6.5, nifty: 11, base: 12, moonshot: 18.7 },
      exitLoad: 80,
    });
  });
});

import { buildQuarterlyReport, type RawReview } from "@/lib/domain/quarterly-report";

const RAW: RawReview = {
  client: { id: "c", name: "Demo Client", code: "D1" }, quarterEnd: "2026-09-30", today: "2026-10-12", asOf: "2026-10-12", casDate: "2026-09-29",
  windowStart: "2026-07-01", reviewNo: 1, planName: null,
  funds: [{ key: "a", isin: null, amfi: null, name: "Alpha Mid Cap Fund - Direct Plan - Growth", category: "Equity Scheme - Mid Cap Fund", amc: "Alpha", units: 100, value: 12000, cost: 10000, casValue: 11800, nav: 120 }],
  sold: [{ key: "n", name: "New Fund - Direct Plan - Growth", category: null, amfi: null, nav: null }],
  txns: [
    { key: "a", name: "Alpha", date: "2026-07-10", side: "BUY", units: 100, amount: 10000 },
    { key: "n", name: "New Fund", date: "2026-10-05", side: "BUY", units: null, amount: 5000, approved: true },
  ],
  planLines: [], planDeltas: [], sips: [], ownTrades: [], baseline: [], sipMonthly: 0, navs: new Map(), benchmarks: [], fundIndex: {},
  otherClientNames: [], market: { rows: [] }, navFailed: [],
};

describe("quarterly report", () => {
  it("values new money without any NAV at cost, with a warning, never at zero", () => {
    const r = buildQuarterlyReport(RAW, {});
    expect(r.score.rows.find((x) => x.key === "n")).toMatchObject({ newIn: 5000, worth: 5000, ret: 0 });
    expect(r.score.rows.find((x) => x.key === "a")).toMatchObject({ newIn: 10000, worth: 12000 });
    expect(r.checks.warnings.join(" ")).toMatch(/No NAV for New: valued at cost/);
    expect(r.windowEnd).toBe("2026-10-12");
  });
});
