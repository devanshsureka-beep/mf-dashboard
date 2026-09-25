import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyTransaction, normaliseLine, parseCasLines, parseNumber, toCasParseResult, CasParseError } from "@/lib/parsers/cas";
import { mapSellAction, parseAdvisoryReportLines, parseAmount, sameInvestor, ReportParseError } from "@/lib/parsers/advisory-report";
import { casParseResultSchema } from "@/lib/integrations/contracts";

const casLines = readFileSync("tests/fixtures/cas-kfin-cams.sample.txt", "utf8").split("\n");
const reportLines = readFileSync("tests/fixtures/univest-report.sample.txt", "utf8").split("\n");
const report2Lines = readFileSync("tests/fixtures/univest-report-2.sample.txt", "utf8").split("\n");

describe("CAS parser (KFintech + CAMS consolidated, detailed)", () => {
  const p = parseCasLines(casLines);

  it("reads investor identity and statement dates", () => {
    expect(p.investor).toEqual({ name: "Test Investor", email: "test.investor@example.com", mobile: "9800001234", pan: "ABCPT1234Q" });
    expect(p.period).toEqual({ from: "1980-01-01", to: "2026-09-19" });
    expect(p.valuationDate).toBe("2026-09-18");
    expect(p.source).toBe("KFINTECH");
  });

  it("reads every folio, including wrapped scheme names and ISINs on the next line", () => {
    expect(p.schemes).toHaveLength(7);
    const hsbc = p.schemes.find((s) => s.schemeName.startsWith("HSBC Value Fund"))!;
    expect(hsbc.isin).toBe("INF917K01HD4");
    expect(hsbc.schemeName).toBe("HSBC Value Fund - Direct Growth");
    const cons = p.schemes.find((s) => /Consumption/.test(s.schemeName))!;
    expect(cons.isin).toBe("INF209K01WC7");
    expect(cons.schemeName).not.toMatch(/formerly/i);
    expect(p.schemes.every((s) => s.planType === "DIRECT")).toBe(true);
    expect(p.schemes[0].amc).toBe("360 ONE Mutual Fund");
  });

  it("reads closing balances and cross-checks against the portfolio summary (no warnings)", () => {
    expect(p.warnings).toEqual([]);
    const first = p.schemes[0];
    expect(first).toMatchObject({ closingUnits: 1852.842, nav: 17.1753, navDate: "2026-09-18", marketValue: 31823.12, costValue: 20000 });
    const total = p.schemes.reduce((t, s) => t + (s.marketValue ?? 0), 0);
    expect(Math.abs(total - (p.summaryTotal.market ?? 0))).toBeLessThan(1);
  });

  it("parses transactions with dates, signed amounts/units, NAV and balance, across page breaks", () => {
    const first = p.schemes[0];
    expect(first.transactions.filter((t) => t.type !== "STAMP_DUTY")).toHaveLength(5);
    expect(first.transactions[0]).toMatchObject({ date: "2023-06-30", type: "PURCHASE", amount: 1999.9, units: 199.99, nav: 10, balanceUnits: 199.99 });
    const redemption = p.schemes.flatMap((s) => s.transactions).find((t) => t.type === "REDEMPTION")!;
    expect(redemption.amount).toBeLessThan(0);
    expect(redemption.units).toBeLessThan(0);
    expect(redemption.balanceUnits).toBe(0);
    expect(p.schemes.flatMap((s) => s.transactions).some((t) => t.type === "SIP")).toBe(true);
  });

  it("maps to the ingestion contract (holdings exclude fully redeemed folios)", () => {
    const r = toCasParseResult(p, "11111111-1111-4111-8111-111111111111");
    expect(casParseResultSchema.safeParse(r).success).toBe(true);
    expect(r.holdings.length).toBe(p.schemes.filter((s) => (s.closingUnits ?? 0) > 0).length);
    expect(r.holdings.every((h) => h.units > 0)).toBe(true);
    expect(r.transactions.length).toBeGreaterThan(20);
  });

  it("rejects documents that are not a detailed CAS", () => {
    expect(() => parseCasLines(["Hello", "world"])).toThrow(CasParseError);
    expect(() => parseCasLines(["Consolidated Account Statement", "Folio No : 1 | PAN: ABCDE1234F"])).toThrow(/DETAILED/);
  });

  it("handles glued dates, negative brackets and transaction wording", () => {
    expect(normaliseLine("30-Jun-202310-Aug-2023 | Purchase")).toBe("30-Jun-2023 | 10-Aug-2023 | Purchase");
    expect(normaliseLine("Closing Unit Balance: 1,852.84206-Feb-2024 | x")).toBe("Closing Unit Balance: 1,852.842 | 06-Feb-2024 | x");
    expect(parseNumber("(41,124.65)")).toBe(-41124.65);
    expect(parseNumber("—")).toBeNull();
    expect(classifyTransaction("SIP Purchase Instalment No - 2/2114 Online").type).toBe("SIP");
    expect(classifyTransaction("Redemption - NEFT PAYOUT - 1553").type).toBe("REDEMPTION");
    expect(classifyTransaction("Switch Out - To HDFC Flexi Cap").type).toBe("SWITCH_OUT");
    expect(classifyTransaction("Switch-In - From Liquid Fund").type).toBe("SWITCH_IN");
    expect(classifyTransaction("*** SIP Cancelled ***")).toEqual({ type: "OTHER", sipCancelled: true });
    expect(classifyTransaction("Purchase - INZ000031633").type).toBe("PURCHASE");
    expect(classifyTransaction("*** Stamp Duty ***").type).toBe("STAMP_DUTY");
  });
});

describe("Univest advisory report parser", () => {
  const r = parseAdvisoryReportLines(reportLines);

  it("reads client, profile and dates", () => {
    expect(r.clientName).toBe("Test Investor");
    expect(r.riskProfile).toBe("MODERATE");
    expect(r.goal).toMatch(/Wealth creation/);
    expect(r.valuationDate).toBe("2026-09-23");
    expect(r.preparedDate).toBe("2026-09-24");
    expect(r.currentValue).toBe(1577657);
    expect(r.warnings).toEqual([]);
  });

  it("reads the sell table with folios and actions; totals reconcile", () => {
    expect(r.sells).toHaveLength(9);
    expect(r.sells.filter((s) => s.action === "SWITCH")).toHaveLength(1);
    expect(r.sells.every((s) => s.folio)).toBe(true);
    expect(r.sellTotal).toBe(1577656.82);
    expect(Math.abs(r.sells.reduce((t, s) => t + s.value, 0) - 1577656.82)).toBeLessThan(2);
  });

  it("reads the buy table with AMC, category and plan type", () => {
    expect(r.buys).toHaveLength(8);
    expect(r.buys[0]).toMatchObject({ fund: "Nippon India Multi Asset Allocation Fund", amc: "Nippon", category: "Multi Asset", planType: "DIRECT", amount: 300000 });
    expect(r.buyTotal).toBe(1577656.82);
  });

  it("reads the SIP table (start / stop)", () => {
    expect(r.sips.filter((s) => s.change === "START").map((s) => s.next)).toEqual([2000, 1500, 1500, 1500, 1100]);
    expect(r.sips.filter((s) => s.change === "STOP")).toHaveLength(4);
    expect(r.sips.find((s) => /HDFC/.test(s.fund))).toMatchObject({ current: 600, frequencyNote: "₹20/day" });
    expect(r.sipTotals).toEqual({ current: 7600, next: 7600 });
  });

  it("flags totals that do not reconcile instead of guessing", () => {
    const broken = reportLines.map((l) => l.replace("| Full exit | ₹4,37,226 |", "| Full exit | ₹4,00,000 |"));
    expect(parseAdvisoryReportLines(broken).warnings.some((w) => /Sell rows add up/.test(w))).toBe(true);
    expect(() => parseAdvisoryReportLines(["random text"])).toThrow(ReportParseError);
  });

  it("maps action wording and compares investor names", () => {
    expect(mapSellAction("Full exit")).toBe("SELL");
    expect(mapSellAction("Switch to Direct")).toBe("SWITCH");
    expect(mapSellAction("Retain")).toBe("RETAIN");
    expect(mapSellAction("??")).toBe("UNKNOWN");
    expect(mapSellAction("Trim, oldest units first")).toBe("SELL");
    expect(sameInvestor("Ravi Kumar Test", "RAVI KUMAR TEST")).toBe(true);
    expect(sameInvestor("Sunita Rao", "Ravi Kumar Test")).toBe(false);
  });
});

describe("Univest report, second layout (partial trim, wrapped cells, SIP routing panel)", () => {
  const r = parseAdvisoryReportLines(report2Lines);

  it("reads every table and everything reconciles", () => {
    expect(r.problems).toEqual([]);
    expect(r.clientName).toBe("Sample Client");
    expect(r.riskProfile).toBe("AGGRESSIVE");
  });

  it("reads a partial trim whose action text wraps into two cells", () => {
    expect(r.sells).toHaveLength(6);
    const trim = r.sells.find((s) => /HDFC Large Cap/.test(s.fund))!;
    expect(trim).toMatchObject({ action: "SELL", partial: true, value: 500000, actionText: "Trim, oldest units first", folio: "70000005/73" });
    expect(r.sells.filter((s) => !s.partial)).toHaveLength(5);
    expect(r.sellTotal).toBe(3826013);
  });

  it("reads the SIP table even with the routing panel printed in between, and ties it out", () => {
    expect(r.sips).toHaveLength(18);
    expect(r.sips.filter((s) => s.change === "START")).toHaveLength(9);
    expect(r.sips.filter((s) => s.change === "STOP")).toHaveLength(8);
    expect(r.sips.find((s) => s.change === "CHANGE")).toMatchObject({ fund: "DSP Small Cap Fund", current: 16500, next: 12000 });
    expect(r.sips.find((s) => s.excludedFromTotal)).toMatchObject({ change: "STOP", current: 20000 });
    expect(r.sipTotals).toEqual({ current: 125700, next: 120000 });
    expect(r.sipRouting).toHaveLength(10);
  });

  it("reads one verdict per holding in the fund-wise review", () => {
    expect(r.review).toHaveLength(11);
    expect(r.review.find((x) => /HDFC Large Cap/.test(x.fund))).toMatchObject({ verdict: "TRIM", amount: 500000 });
    expect(r.review.find((x) => /Invesco/.test(x.fund))).toMatchObject({ verdict: "ADD", amount: 400000 });
    expect(r.buys.find((b) => /Invesco/.test(b.fund))?.kind).toBe("TOP_UP");
  });

  it("parses rupee amounts in lakh / crore notation with their precision", () => {
    expect(parseAmount("₹5.00L")).toEqual({ value: 500000, precision: 500 });
    expect(parseAmount("₹38,26,013.13")).toEqual({ value: 3826013.13, precision: 1 });
    expect(parseAmount("₹1.2 Cr")?.value).toBe(12000000);
    expect(parseAmount("20,000*")?.value).toBe(20000);
  });

  describe("tampering with any figure is caught (nothing is guessed)", () => {
    const tamper = (from: string, to: string) => {
      const lines = report2Lines.map((l) => l.replace(from, to));
      expect(lines).not.toEqual(report2Lines);
      return parseAdvisoryReportLines(lines).problems;
    };
    it("a sell row dropped", () => {
      const lines = report2Lines.filter((l) => !l.startsWith("HDFC Large Cap Fund (Reg) | 70000005"));
      const p = parseAdvisoryReportLines(lines).problems;
      expect(p.some((x) => /Sell rows add up/.test(x))).toBe(true);
      expect(p.some((x) => /TRIM .* no row/.test(x))).toBe(true);
    });
    it("a sell value that disagrees with the review", () => {
      expect(tamper("| Full exit | ₹5,62,206 |", "| Full exit | ₹5,00,000 |").some((x) => /UTI Nifty 50/.test(x))).toBe(true);
    });
    it("a review verdict that disagrees with the sell list", () => {
      expect(tamper("| 6.9% | 6.9% | EXIT |", "| 6.9% | 6.9% | HOLD |").some((x) => /HOLD .*sells it|no EXIT/.test(x))).toBe(true);
    });
    it("a SIP amount that disagrees with the routing panel and total", () => {
      const p = tamper("Bandhan Small Cap Fund | — | 15,000 | New", "Bandhan Small Cap Fund | — | 16,000 | New");
      expect(p.some((x) => /New SIP rows add up/.test(x))).toBe(true);
      expect(p.some((x) => /routing panel lists Bandhan/.test(x))).toBe(true);
    });
    it("a SIP row whose wording contradicts its amounts", () => {
      expect(tamper("Kotak Mid Cap Fund | 13,200 | — | Stop", "Kotak Mid Cap Fund | 13,200 | — | New").some((x) => /says "New"/.test(x))).toBe(true);
    });
    it("a buy row dropped", () => {
      const lines = report2Lines.filter((l) => !l.startsWith("DSP India T.I.G.E.R. Fund | ₹3,50,000"));
      expect(parseAdvisoryReportLines(lines).problems.some((x) => /Buy rows add up/.test(x))).toBe(true);
    });
  });
});

describe("ISIN reading", () => {
  it("validates the ISIN check digit", async () => {
    const { isValidIsin } = await import("@/lib/parsers/cas");
    expect(isValidIsin("INF769K01101")).toBe(true);
    expect(isValidIsin("INF917K01HD4")).toBe(true);
    expect(isValidIsin("INF769K01102")).toBe(false);
    expect(isValidIsin("INF769K0110")).toBe(false);
  });

  it("re-joins an ISIN the two-column header pushed onto the next line, only with a valid check digit", async () => {
    const { findIsin } = await import("@/lib/parsers/cas");
    const header = [
      "117EBRGG-Mirae Asset Large and Midcap Fund (formerly Mirae Asset Emerging Bluechip Fund) - Regular Plan (Non Demat) - ISIN: INF769K | Registrar :",
      "01101(Advisor: ARN-0000) | KFINTECH",
    ];
    expect(findIsin(header)).toBe("INF769K01101");
    expect(findIsin([header[0], "01109(Advisor: ARN-0000) | KFINTECH"])).toBeNull(); // wrong digits never accepted
    expect(findIsin(["X Fund - Direct | (Demat) (Advisor:INZ000031633) - ISIN:INF917K01HD4 | Registrar : CAMS"])).toBe("INF917K01HD4");
  });
});
