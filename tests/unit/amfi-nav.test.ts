import { describe, expect, it } from "vitest";
import { amfiDate, optionTypeFromName, parseAmfiNav, planTypeFromName } from "@/lib/parsers/amfi-nav";

// Real ISINs (public scheme identifiers), made-up NAVs.
const SAMPLE = `Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date

Open Ended Schemes(Equity Scheme - Large Cap Fund)

HDFC Mutual Fund

100119;INF179K01BE2;-;HDFC Large Cap Fund - Growth Option - Regular Plan;1102.3300;25-Sep-2026
119018;INF179K01XQ0;-;HDFC Large Cap Fund - Growth Option - Direct Plan;1210.5500;25-Sep-2026

Open Ended Schemes(Equity Scheme - Large & Mid Cap Fund)

Mirae Asset Mutual Fund

112932;INF769K01101;-;Mirae Asset Large & Midcap Fund - Regular Plan-Growth Option;155.9200;25-Sep-2026
999999;INF000000000;INF000000001;Broken Scheme;12.00;25-Sep-2026
100000;INF769K01010;-;Mirae Asset Large Cap Fund - Regular Plan - Growth;N.A.;24-Sep-2026
`;

describe("AMFI NAV file", () => {
  it("reads every scheme with its AMC, category, plan, NAV and date", () => {
    const p = parseAmfiNav(SAMPLE);
    expect(p.navDate).toBe("2026-09-25");
    const hdfc = p.schemes.find((s) => s.isin === "INF179K01BE2")!;
    expect(hdfc).toMatchObject({
      amfi_code: "100119", amc: "HDFC Mutual Fund", category: "Equity Scheme - Large Cap Fund",
      plan_type: "REGULAR", option_type: "GROWTH", nav: 1102.33, nav_date: "2026-09-25",
    });
    const mirae = p.schemes.find((s) => s.isin === "INF769K01101")!;
    expect(mirae.amc).toBe("Mirae Asset Mutual Fund");
    expect(mirae.category).toBe("Equity Scheme - Large & Mid Cap Fund");
  });

  it("keeps a scheme without a NAV (N.A.) but gives it no NAV", () => {
    const p = parseAmfiNav(SAMPLE);
    const na = p.schemes.find((s) => s.isin === "INF769K01010")!;
    expect(na.nav).toBeNull();
    expect(na.nav_date).toBeNull();
  });

  it("drops ISINs whose check digit is wrong", () => {
    const p = parseAmfiNav(SAMPLE);
    expect(p.schemes.find((s) => s.isin.startsWith("INF00000000"))).toBeUndefined();
    expect(p.skipped).toBe(1);
  });

  it("helpers", () => {
    expect(amfiDate("5-Oct-2026")).toBe("2026-10-05");
    expect(amfiDate("garbage")).toBeNull();
    expect(planTypeFromName("X Fund - Direct Plan - IDCW")).toBe("DIRECT");
    expect(optionTypeFromName("X Fund - Direct Plan - IDCW")).toBe("IDCW");
    expect(optionTypeFromName("X Fund - Growth")).toBe("GROWTH");
  });
});
