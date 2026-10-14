import { describe, expect, it } from "vitest";
import { answerToCas, buildCasAiRequest, type CasAiAnswer } from "@/lib/integrations/cas-ai";

// A made-up statement, as Claude would transcribe it.
const answer = (over: Partial<CasAiAnswer["schemes"][number]> = {}): CasAiAnswer => ({
  investor_name: "Sample Investor", email: "Sample@Example.com", mobile: "+91 98200 11001", pan: "ABCDE1234F",
  period_from: "1986-01-01", period_to: "2026-10-13", summary_cost_total: 200000, summary_market_total: 250000,
  schemes: [
    {
      amc: "Sample Mutual Fund", scheme_name: "Sample Flexi Cap Fund - Regular Plan - Growth", isin: "INF179K01BE2", folio: "1234 / 56", pan: "ABCDE1234F",
      advisor: "ARN-12345", closing_units: 1000, nav: 150, nav_date: "2026-10-13", market_value: 150000, cost_value: 120000,
      transactions: [
        { date: "2026-09-05", description: "Purchase-SIP-NSE - Instalment No 7", amount: 2999.85, units: 20, nav: 149.99, balance_units: 1000 },
        { date: "2026-09-05", description: "*** Stamp Duty ***", amount: 0.15, units: 0, nav: 0, balance_units: 0 },
      ],
      ...over,
    },
    {
      amc: "Other Mutual Fund", scheme_name: "Other Large Cap Fund", isin: "", folio: "999", pan: "ABCDE1234F",
      advisor: "DIRECT", closing_units: 500, nav: 200, nav_date: "2026-10-13", market_value: 100000, cost_value: 0, transactions: [],
    },
  ],
});

describe("A CAS read by Claude from a picture-only PDF", () => {
  it("becomes the usual CAS shape, marked as read by Claude and always flagged for a check", () => {
    const cas = answerToCas(answer());
    expect(cas.readByAi).toBe(true);
    expect(cas.investor).toEqual({ name: "Sample Investor", email: "sample@example.com", mobile: "9820011001", pan: "ABCDE1234F" });
    expect(cas.valuationDate).toBe("2026-10-13");
    expect(cas.schemes[0]).toMatchObject({ folio: "1234/56", planType: "REGULAR", isin: "INF179K01BE2", closingUnits: 1000, marketValue: 150000 });
    expect(cas.schemes[1]).toMatchObject({ planType: "DIRECT", isin: null, costValue: null });
    // The stamp-duty line (no units) is dropped; the SIP is classified as the built-in parser would.
    expect(cas.schemes[0].transactions).toEqual([expect.objectContaining({ type: "SIP", units: 20, balanceUnits: 1000 })]);
    expect(cas.warnings).toEqual(["Read by Claude from a picture-only PDF: check the funds and units before confirming the snapshot."]);
  });

  it("runs the same cross-checks as the built-in parser", () => {
    const cas = answerToCas(answer({ market_value: 160000 }));
    expect(cas.warnings.join(" ")).toMatch(/units × NAV ≠ market value/);
    expect(cas.warnings.join(" ")).toMatch(/add up to ₹2,60,000 but the portfolio summary says ₹2,50,000/);
  });

  it("asks for a structured transcription of the attached PDF", () => {
    const req = buildCasAiRequest(new Uint8Array([37, 80, 68, 70]));
    expect(req.output_config.format.type).toBe("json_schema");
    expect(req.messages[0].content[0]).toMatchObject({ type: "document", source: { media_type: "application/pdf", data: "JVBERg==" } });
  });
});
