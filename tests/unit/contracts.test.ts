import { describe, expect, it } from "vitest";
import { advisoryReportResultSchema, casParseResultSchema } from "@/lib/integrations/contracts";
import { bestSecurityMatch, detectPlanType, nameSimilarity } from "@/lib/domain/securities";

const casId = "11111111-1111-4111-8111-111111111111";

describe("integration contracts", () => {
  it("accepts a valid parsed CAS", () => {
    const r = casParseResultSchema.safeParse({
      cas_document_id: casId, status: "PARSED",
      statement: { valuation_date: "2026-09-23" },
      holdings: [{ scheme_name: "X Fund", isin: "inf204k01ab1", units: "10.5", current_value: 1050 }],
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.status === "PARSED") {
      expect(r.data.holdings[0].isin).toBe("INF204K01AB1");
      expect(r.data.holdings[0].units).toBe(10.5);
      expect(r.data.statement.source).toBe("OTHER");
    }
  });
  it("rejects negative values, bad ISINs and empty holdings", () => {
    const base = { cas_document_id: casId, status: "PARSED", statement: { valuation_date: "2026-09-23" } };
    expect(casParseResultSchema.safeParse({ ...base, holdings: [] }).success).toBe(false);
    expect(casParseResultSchema.safeParse({ ...base, holdings: [{ scheme_name: "X", units: -1, current_value: 5 }] }).success).toBe(false);
    expect(casParseResultSchema.safeParse({ ...base, holdings: [{ scheme_name: "X", isin: "BAD", units: 1, current_value: 5 }] }).success).toBe(false);
  });
  it("accepts a FAILED callback with an error message", () => {
    expect(casParseResultSchema.safeParse({ cas_document_id: casId, status: "FAILED", error: "Wrong password" }).success).toBe(true);
  });
  it("requires a client and at least one item for advisory reports", () => {
    expect(advisoryReportResultSchema.safeParse({ plan: { plan_name: "P" }, items: [{ action: "BUY", scheme_name: "Y", target_amount: 5 }] }).success).toBe(false);
    expect(advisoryReportResultSchema.safeParse({ client_code: "MN-00101", plan: { plan_name: "P" } }).success).toBe(false);
    expect(advisoryReportResultSchema.safeParse({ client_code: "MN-00101", plan: { plan_name: "P" }, items: [{ action: "SELL", scheme_name: "Y", target_amount: 5 }] }).success).toBe(true);
  });
});

describe("fund name matching (suggestions only)", () => {
  const pool = [
    { id: "reg", scheme_name: "Mahindra Manulife Multi Cap Fund - Regular Growth", isin: null, plan_type: "REGULAR" },
    { id: "dir", scheme_name: "Mahindra Manulife Multi Cap Fund - Direct Growth", isin: null, plan_type: "DIRECT" },
    { id: "hdfc", scheme_name: "HDFC Flexi Cap Fund - Direct Growth", isin: null, plan_type: "DIRECT" },
  ];
  it("detects plan type from messy names", () => {
    expect(detectPlanType("Mahindra Manulife Multi Cap (Reg)")).toBe("REGULAR");
    expect(detectPlanType("HDFC Flexi Cap - Direct Plan")).toBe("DIRECT");
    expect(detectPlanType("HDFC Flexi Cap")).toBeNull();
  });
  it("prefers the matching plan type", () => {
    expect(bestSecurityMatch("Mahindra Manulife Multi Cap Fund (Reg)", pool).candidate?.id).toBe("reg");
    expect(bestSecurityMatch("Mahindra Manulife Multi Cap Fund - Direct", pool).candidate?.id).toBe("dir");
  });
  it("is not confident when plan type is unknown and two variants exist", () => {
    expect(bestSecurityMatch("Mahindra Manulife Multi Cap Fund", pool).confident).toBe(false);
  });
  it("returns no candidate for unrelated names", () => {
    expect(bestSecurityMatch("Zenith Innovation Opportunities", pool).candidate).toBeNull();
    expect(nameSimilarity("abc", "")).toBe(0);
  });
});
