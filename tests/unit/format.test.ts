import { describe, expect, it } from "vitest";
import { formatDate, formatINR, formatINRCompact, fromISTDateTimeLocal, toISTDateTimeLocal } from "@/lib/format";

describe("Indian rupee formatting", () => {
  it("formats lakhs and crores compactly", () => {
    expect(formatINRCompact(1577657)).toBe("₹15.78L");
    expect(formatINRCompact(10200000)).toBe("₹1.02Cr");
    expect(formatINRCompact(10000000)).toBe("₹1Cr");
    expect(formatINRCompact(4200000)).toBe("₹42L");
    expect(formatINRCompact(25000)).toBe("₹25K");
    expect(formatINRCompact(-700000)).toBe("-₹7L");
    expect(formatINRCompact(null)).toBe("—");
  });
  it("formats full figures with Indian grouping", () => {
    expect(formatINR(1577657)).toBe("₹15,77,657");
    expect(formatINR(1577656.82, { decimals: true })).toBe("₹15,77,656.82");
  });
  it("formats dates in IST as DD-Mon-YYYY", () => {
    expect(formatDate("2026-09-24")).toBe("24-Sep-2026");
    // 20:00 UTC on 23 Sep is already 24 Sep in India
    expect(formatDate(new Date("2026-09-23T20:00:00Z"))).toBe("24-Sep-2026");
  });
  it("round-trips datetime-local values as IST", () => {
    const d = fromISTDateTimeLocal("2026-09-24T10:42");
    expect(d.toISOString()).toBe("2026-09-24T05:12:00.000Z");
    expect(toISTDateTimeLocal(d)).toBe("2026-09-24T10:42");
  });
});
