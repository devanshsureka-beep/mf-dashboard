import { describe, expect, it } from "vitest";
import { planSipMet, sipPointAsOf, sipStatus, type SipTxn } from "@/lib/domain/sip-status";

const sip = (isin: string, date: string, amount: number, folio = "F1"): SipTxn => ({
  date, type: "SIP", isin, scheme_name: `Fund ${isin}`, folio_number: folio, amount, description: "SIP Purchase - Instalment",
});
const months = (isin: string, from: number, to: number, amount: number, year = 2026) =>
  Array.from({ length: to - from + 1 }, (_, i) => sip(isin, `${year}-${String(from + i).padStart(2, "0")}-07`, amount));

describe("SIP status from CAS transactions", () => {
  it("active when an instalment fell in the last 40 days; amount is net-of-stamp-duty rounded", () => {
    const p = sipPointAsOf(months("A", 1, 9, 9999.5), "2026-09-23");
    expect(p).toMatchObject({ state: "ACTIVE", amount: 10000, lastInstalment: "2026-09-07" });
  });

  it("counts purchases the RTA marks as Systematic as instalments", () => {
    const t = months("A", 7, 9, 2500).map((x) => ({ ...x, type: "PURCHASE", description: "Purchase- Systematic-BSE - Instalment No - 42" }));
    expect(sipPointAsOf(t, "2026-09-23").state).toBe("ACTIVE");
    expect(sipPointAsOf([{ ...t[0], description: "Purchase" }], "2026-07-20").state).toBe("NONE");
  });

  it("treats 3+ plain purchases of the same amount about a month apart as a SIP (broker / platform SIPs)", () => {
    const plain = months("P", 6, 9, 16499.18).map((x) => ({ ...x, type: "PURCHASE", description: "Purchase - INZ000031633" }));
    expect(sipPointAsOf(plain, "2026-09-23")).toMatchObject({ state: "ACTIVE", amount: 16500 });
    // Two one-off lump sums are not a SIP.
    expect(sipPointAsOf(plain.slice(0, 2), "2026-07-20").state).toBe("NONE");
    // A lump sum next to a running SIP is ignored.
    const mixed = [...plain, { ...plain[0], date: "2026-09-12", amount: 250000 }];
    expect(sipPointAsOf(mixed, "2026-09-23").amount).toBe(16500);
  });

  it("adds up two SIPs running in the same folio; a new amount after the old one ends is a change, not a second SIP", () => {
    const two = [...months("U", 6, 9, 16499.18), ...months("U", 6, 9, 10999.45).map((x) => ({ ...x, date: x.date.replace(/-07$/, "-15") }))];
    expect(sipPointAsOf(two, "2026-09-23")).toMatchObject({ state: "ACTIVE", amount: 27500, count: 2 });
    const stepped = [...months("C", 6, 8, 16500), ...months("C", 9, 9, 12000)];
    expect(sipPointAsOf(stepped, "2026-09-23")).toMatchObject({ amount: 12000, count: 1 });
  });

  it("stopped when instalments stop, or when the CAS prints a cancellation", () => {
    expect(sipPointAsOf(months("A", 1, 6, 5000), "2026-09-23").state).toBe("STOPPED");
    const cancelled = [...months("B", 1, 9, 5000), { ...sip("B", "2026-09-15", 0), type: "OTHER", amount: null, description: "*** SIP Cancelled ***" }];
    expect(sipPointAsOf(cancelled, "2026-09-23")).toMatchObject({ state: "STOPPED", cancelledOn: "2026-09-15" });
  });

  it("compares the previous CAS with the latest: started, stopped, amount changed", () => {
    const txns = [
      ...months("STOP", 1, 9, 10000),          // stopped after Sep
      ...months("START", 10, 11, 7000),        // new in Oct
      ...months("CHG", 1, 9, 16500), ...months("CHG", 10, 11, 12000),
      ...months("SAME", 1, 11, 2000),
    ];
    const s = sipStatus(txns, "2026-11-20", "2026-09-23");
    const by = Object.fromEntries(s.map((r) => [r.isin, r]));
    expect(by.STOP.change).toBe("STOPPED");
    expect(by.START.change).toBe("STARTED");
    expect(by.START.now.amount).toBe(7000);
    expect(by.CHG).toMatchObject({ change: "AMOUNT_CHANGED", before: { amount: 16500 }, now: { amount: 12000 } });
    expect(by.SAME.change).toBe("UNCHANGED");
    expect(s[0].change).not.toBe("UNCHANGED"); // changes first
  });

  it("leaves out SIPs that ended more than a year before the CAS", () => {
    const s = sipStatus([...months("OLD", 1, 6, 5000, 2018), ...months("NEW", 1, 9, 3000)], "2026-09-23", null);
    expect(s.map((r) => r.isin)).toEqual(["NEW"]);
  });

  it("with only one CAS, shows the current state", () => {
    const s = sipStatus(months("A", 1, 9, 3000), "2026-09-23", null);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ change: "FIRST_CAS", before: null, now: { state: "ACTIVE" } });
  });

  it("checks a planned SIP change against the CAS", () => {
    const active = { state: "ACTIVE" as const, amount: 12000, lastInstalment: "2026-11-07", cancelledOn: null, count: 1 };
    const stopped = { ...active, state: "STOPPED" as const };
    expect(planSipMet({ action: "CHANGE", isin: "X", new_amount: 12000, old_amount: 16500 }, active)).toBe(true);
    expect(planSipMet({ action: "CHANGE", isin: "X", new_amount: 10000, old_amount: 16500 }, active)).toBe(false);
    expect(planSipMet({ action: "STOP", isin: "X", new_amount: null, old_amount: 10000 }, stopped)).toBe(true);
    expect(planSipMet({ action: "START", isin: "X", new_amount: 7000, old_amount: null }, null)).toBe(false);
  });
});
