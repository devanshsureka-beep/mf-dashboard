import { describe, expect, it } from "vitest";
import { marketCap, mix, type MixRow } from "@/lib/domain/market-cap";

describe("marketCap", () => {
  it("reads the AMFI category", () => {
    expect(marketCap("Equity Scheme - Large Cap Fund", "Axis Bluechip Fund")).toBe("Large cap");
    expect(marketCap("Equity Schemes - Large & Mid Cap Fund", "Motilal Oswal Large and Midcap")).toBe("Large & mid");
    expect(marketCap("Equity Scheme - Mid Cap Fund", "Kotak Emerging Equity")).toBe("Mid cap");
    expect(marketCap("Equity Schemes - Small Cap Fund", "Bandhan Small Cap")).toBe("Small cap");
    expect(marketCap("Equity Scheme - Flexi Cap Fund", "PGIM India Flexi Cap")).toBe("Flexi / multi");
    expect(marketCap("Equity Schemes - Multi Cap Fund", "Nippon India Multi Cap")).toBe("Flexi / multi");
    expect(marketCap("Equity Schemes - ELSS- Tax Saver Fund", "Mirae ELSS")).toBe("Flexi / multi");
    expect(marketCap("Equity Scheme - Sectoral/ Thematic", "ABSL Digital India")).toBe("Sectoral");
  });

  it("puts non-equity funds in Other", () => {
    expect(marketCap("Hybrid Scheme - Multi Asset Allocation", "Nippon India Multi Asset")).toBe("Other");
    expect(marketCap("Debt Scheme - Liquid Fund", "HDFC Liquid")).toBe("Other");
    expect(marketCap("Other Scheme - FoF Domestic", "Nippon India Silver ETF FoF")).toBe("Other");
    expect(marketCap("Other Scheme - FoF Overseas", "Motilal Oswal Nasdaq 100 FoF")).toBe("Other");
  });

  it("reads index funds and ETFs by their index", () => {
    expect(marketCap("Other Scheme - Index Funds", "UTI Nifty 50 Index Fund")).toBe("Large cap");
    expect(marketCap("Other Scheme - Index Funds", "ICICI Pru Nifty Next 50 Index")).toBe("Large cap");
    expect(marketCap("Index Funds - Equity Funds", "Motilal Oswal Nifty Midcap 150 Index")).toBe("Mid cap");
    expect(marketCap("Other Scheme - Index Funds", "Nippon India Nifty Smallcap 250 Index")).toBe("Small cap");
    expect(marketCap("Other Scheme - Index Funds", "Edelweiss Nifty Large Mid Cap 250 Index")).toBe("Large & mid");
    expect(marketCap(null, "Navi Nifty Bank Index Fund")).toBe("Sectoral");
  });
});

describe("mix", () => {
  const h = (name: string, category: string, value: number, amc = "HDFC Mutual Fund"): MixRow => ({ name, category, amc, value });
  const holdings = [
    h("Axis Bluechip", "Equity Scheme - Large Cap Fund", 25, "Axis Mutual Fund"),
    h("Kotak Emerging", "Equity Scheme - Mid Cap Fund", 22, "Kotak Mahindra Mutual Fund"),
    h("HDFC Corporate Bond", "Debt Scheme - Corporate Bond Fund", 8),
  ];
  // Sell ₹15 of the large cap, buy ₹5 of a small cap; a sell bigger than the holding stops at zero.
  const plan = [
    h("Axis Bluechip", "Equity Scheme - Large Cap Fund", -15, "Axis Mutual Fund"),
    h("Bandhan Small Cap", "Equity Scheme - Small Cap Fund", 5, "Bandhan Mutual Fund"),
    h("Kotak Emerging", "Equity Scheme - Mid Cap Fund", -40, "Kotak Mahindra Mutual Fund"),
  ];

  it("gives now and after the plan in the fixed market-cap order", () => {
    const m = mix(holdings, plan, "cap");
    expect(m.now).toBe(55);
    expect(m.after).toBe(10 + 0 + 5 + 8);
    expect(m.slices.map((s) => [s.label, s.now, s.after])).toEqual([
      ["Large cap", 25, 10], ["Mid cap", 22, 0], ["Small cap", 0, 5], ["Other", 8, 8],
    ]);
    expect(m.slices[0].nowShare).toBeCloseTo(25 / 55);
    expect(m.slices.find((s) => s.label === "Other")?.hint).toMatch(/debt/i);
  });

  it("groups by asset class and by AMC", () => {
    expect(mix(holdings, [], "class").slices.map((s) => s.label)).toEqual(["Equity", "Debt"]);
    const amc = mix(holdings, plan, "amc", 2).slices.map((s) => [s.label, s.now, s.after]);
    expect(amc).toEqual([["Axis", 25, 10], ["Kotak Mahindra", 22, 0], ["Other", 8, 13]]);
  });
});
