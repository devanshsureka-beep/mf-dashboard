import { describe, expect, it } from "vitest";
import { amcName, assetClass, groupBook, insights, shortCategory, slices, type BookHolding } from "@/lib/domain/book";

const h = (over: Partial<BookHolding>): BookHolding => ({
  client_id: "c1", client_name: "Demo One", advisor_name: "Adv A", risk_profile: "MODERATE", security_id: null,
  scheme_name: "Demo Flexi Cap Fund - Direct Growth", category: "Equity Scheme - Flexi Cap Fund", amc: "Demo AMC", plan_type: "DIRECT", value: 100, ...over,
});

describe("book", () => {
  it("asset class from the AMFI category and the name", () => {
    expect(assetClass("Equity Scheme - Small Cap Fund", "X")).toBe("Equity");
    expect(assetClass("Debt Scheme - Liquid Fund", "X")).toBe("Debt");
    expect(assetClass("Hybrid Scheme - Balanced Advantage", "X")).toBe("Hybrid");
    expect(assetClass("Other Scheme - FoF Domestic", "Demo Gold Fund")).toBe("Gold & silver");
    expect(assetClass("Fund of Funds Scheme (Overseas)", "Demo US Equity FoF")).toBe("International");
    expect(assetClass(null, "Demo Nifty 50 Index Fund")).toBe("Equity");
    expect(shortCategory("Equity Scheme - Small Cap Fund", "X")).toBe("Small Cap");
    // The AMFI type decides; the name only for types that say nothing.
    expect(assetClass("Other Scheme - Index Funds", "Demo Bharat Bond ETF FOF April 2030")).toBe("Debt");
    expect(assetClass("Other Scheme - Other  ETFs", "Demo Liquid BeES")).toBe("Debt");
    expect(assetClass("Equity Scheme - Sectoral/ Thematic", "Demo Magnum Global Fund")).toBe("Equity");
    expect(assetClass("Index Funds - Debt Funds", "Demo SDL Index")).toBe("Debt");
    expect(assetClass("Exchange Traded Funds (ETFs) - Silver ETF", "Demo Silver")).toBe("Gold & silver");
    expect(assetClass(null, "Demo US Technology Equity FoF")).toBe("International");
    expect(assetClass(null, "Demo Midcap 150 Fund")).toBe("Equity");
    expect(assetClass(null, "Demo Infrastructure Fund")).toBe("Equity");
    expect(assetClass(null, "Demo Passive Multi-Asset FoF")).toBe("Hybrid");
    expect(shortCategory(null)).toBe("Uncategorised");
    expect(shortCategory("Equity Scheme - Sectoral/ Thematic")).toBe(shortCategory("Equity Scheme - Sectoral / Thematic"));
    expect(shortCategory("Equity Schemes - ELSS- Tax Saver Fund")).toBe("ELSS");
  });

  it("one AMC under one name", () => {
    expect(amcName("HDFC Mutual Fund")).toBe(amcName("HDFC"));
    expect(amcName("MOTILAL OSWAL MUTUAL FUND")).toBe("Motilal Oswal");
    expect(amcName("Aditya Birla SL")).toBe(amcName("Aditya Birla Sun Life Mutual Fund"));
    expect(amcName("Quant MF")).toBe("Quant");
    expect(amcName(null)).toBe("Unknown AMC");
  });

  it("slices fold the tail into Other and add up to the book", () => {
    const rows = ["A", "B", "C", "D"].map((k, i) => h({ amc: k, value: 40 - i * 10 }));
    const s = slices(rows, (r) => r.amc ?? "", 3);
    expect(s.map((x) => x.label)).toEqual(["A", "B", "Other"]);
    expect(s.reduce((t, x) => t + x.value, 0)).toBe(100);
  });

  it("insights: small-cap heavy clients, concentration, regular plans", () => {
    const rows = [
      h({ client_id: "c1", category: "Equity Scheme - Small Cap Fund", scheme_name: "Demo Small Cap Fund - Regular Growth", plan_type: "REGULAR", value: 60, security_id: "s1" }),
      h({ client_id: "c1", value: 40, security_id: "s2" }),
      h({ client_id: "c2", client_name: "Demo Two", value: 10, security_id: "s3", scheme_name: "Third" }),
      h({ client_id: "c2", client_name: "Demo Two", value: 5, security_id: "s4", scheme_name: "Fourth" }),
    ];
    const out = insights(rows, { inBank: 0, inBankClients: 0 });
    expect(out[0]).toMatchObject({ title: "1 client hold over 40% in small cap", detail: "1 of them not marked Aggressive" });
    expect(out.some((i) => /Top 3 funds/.test(i.title))).toBe(true);
    expect(out.some((i) => /1 holding is a Regular plan/.test(i.title))).toBe(true);
    expect(out.some((i) => /in bank/.test(i.title))).toBe(false);
  });

  it("groups category › fund › client, largest first, with shares of the book", () => {
    const rows = [h({ value: 30, security_id: "s1" }), h({ client_id: "c2", client_name: "Demo Two", value: 50, security_id: "s1" }), h({ category: "Debt Scheme - Liquid Fund", scheme_name: "Demo Liquid", value: 20, security_id: "s9" })];
    const g = groupBook(rows, "category");
    expect(g.map((x) => [x.label, x.value, x.clients])).toEqual([["Flexi Cap", 80, 2], ["Liquid", 20, 1]]);
    expect(g[0].children[0].children.map((c) => c.label)).toEqual(["Demo Two", "Demo One"]);
    expect(g[0].share).toBeCloseTo(0.8);
  });
});
