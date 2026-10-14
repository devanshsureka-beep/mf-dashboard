import { describe, expect, it } from "vitest";
import { imageOnly } from "@/lib/cas/reader";

describe("A PDF whose pages are pictures (scanned / Microsoft Print to PDF)", () => {
  it("is recognised as having no text; a real statement is not", () => {
    expect(imageOnly(["@@PAGE_BREAK 1", "@@PAGE_BREAK 2"])).toBe(true);
    expect(imageOnly(["Consolidated Account Statement", "Folio No: 123 PAN: OK KYC: OK", "Closing Unit Balance: 10.000", "@@PAGE_BREAK 1"])).toBe(false);
  });
});
