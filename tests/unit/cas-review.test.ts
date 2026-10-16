import { describe, expect, it } from "vitest";
import { explainCasWarnings, maskPan, maskPans, totalMatches } from "@/lib/domain/cas-review";

const sensex = "Demo Sensex Index Fund - Direct Plan - Growth Option";

describe("explainCasWarnings", () => {
  it("one point per fund for the fund-code warnings, with the fund it was matched to", () => {
    const pts = explainCasWarnings(
      [`ISIN for folio 1234567/89 (${sensex}) could not be read with a valid check digit.`, `${sensex}: ISIN missing — security matched by name only.`],
      [{ scheme_name: sensex, folio_number: "1234567/89", isin: null, matched_name: "Demo Sensex Index Fund Direct Growth", units: 412.3, current_value: 118400 }],
    );
    expect(pts).toHaveLength(1);
    expect(pts[0]).toMatchObject({ kind: "FUND_MATCH", severity: "review", folio: "1234567/89" });
    expect(pts[0].detail).toContain("matched it by name to Demo Sensex Index Fund Direct Growth");
    expect(pts[0].detail).toContain("₹1,18,400");
    expect(totalMatches(pts)).toBe(true);
  });

  it("a folio with several funds: the point names the fund of the warning, not another fund in that folio", () => {
    const pts = explainCasWarnings([`ISIN for folio 555/1 (Demo Balanced Fund - Regular Growth) could not be read with a valid check digit.`], [
      { scheme_name: "Demo Midcap Fund - Regular Growth", folio_number: "555/1", isin: "INF000000001", matched_name: "Demo Midcap Fund", units: 10, current_value: 1000 },
      { scheme_name: "Demo Balanced Fund - Regular Growth", folio_number: "555/1", isin: null, matched_name: null, units: 5, current_value: 500 },
    ]);
    expect(pts).toHaveLength(1);
    expect(pts[0].detail).not.toContain("Midcap");
    expect(pts[0].detail).toContain("could not match it");
  });

  it("totals, PAN and duplicates are blocking; a PAN is never shown in full", () => {
    const pts = explainCasWarnings([
      "Holdings add up to ₹1,00,000 but the statement total is ₹1,20,000.",
      "Statement PAN ABCDE1234F does not match the client's PAN ZYXWV9876K.",
      "A snapshot with the same valuation date and total value already exists — possible duplicate statement.",
    ]);
    expect(pts.map((p) => p.kind)).toEqual(["TOTAL", "PAN", "DUPLICATE"]);
    expect(pts.every((p) => p.severity === "blocked")).toBe(true);
    expect(pts[1].detail).not.toContain("ABCDE1234F");
    expect(pts[1].detail).toContain("234F");
    expect(totalMatches(pts)).toBe(false);
  });

  it("units that don't add up, and anything unknown, stay as points to check", () => {
    const pts = explainCasWarnings(["Demo Fund (99/1): last transaction balance 30.277 ≠ closing units 0.", "Something new."]);
    expect(pts[0]).toMatchObject({ kind: "UNITS", folio: "99/1" });
    expect(pts[1]).toMatchObject({ kind: "OTHER", detail: "Something new." });
  });

  it("maskPan", () => expect(maskPan("ABCDE1234F")).toBe("••••••234F"));

  it("a misread PAN and family PANs are masked too; folio numbers are not", () => {
    const pts = explainCasWarnings([
      "Statement PAN ABCDE1Z34F does not match the client's PAN ZYXWV9876K.",
      "This CAS also contains folios of other PAN(s): QWERT1234Y, ASDF12345 (family consolidation).",
    ]);
    const text = pts.map((p) => p.detail).join(" ");
    for (const pan of ["ABCDE1Z34F", "ZYXWV9876K", "QWERT1234Y", "ASDF12345"]) expect(text).not.toContain(pan);
    expect(maskPans("ISIN for folio 1234567/89 (Demo) could not be read")).toBe("ISIN for folio 1234567/89 (Demo) could not be read");
  });
});
