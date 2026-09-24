import { describe, expect, it } from "vitest";
import { reconcile, type CandidateAdvice, type HoldingLine } from "@/lib/domain/reconciliation";

const h = (securityId: string, units: number, nav = 100): HoldingLine => ({
  securityId, isin: null, schemeName: `Fund ${securityId}`, folioNumber: "F1", units, currentValue: units * nav, nav,
});
const advice = (p: Partial<CandidateAdvice> & Pick<CandidateAdvice, "id" | "securityId" | "action">): CandidateAdvice => ({
  status: "ISSUED", quantityBasis: "AMOUNT", advisedAmount: 0, advisedUnits: null, executedAmount: 0, executedUnits: 0,
  unverifiedExecutedAmount: 0, unverifiedExecutedUnits: 0, referencePrice: null, communicatedAt: new Date("2026-09-01T10:00:00+05:30"), ...p,
});
const run = (prev: HoldingLine[], curr: HoldingLine[], adv: CandidateAdvice[], transactions = [] as Parameters<typeof reconcile>[0]["transactions"]) =>
  reconcile({ previous: prev, current: curr, advice: adv, transactions, currentSnapshotDate: "2026-09-20" });

describe("CAS reconciliation engine", () => {
  it("proposes a HIGH match for SELL 400 units when 1000 -> 600 units", () => {
    const out = run([h("A", 1000)], [h("A", 600)], [advice({ id: "adv1", securityId: "A", action: "SELL", quantityBasis: "UNITS", advisedUnits: 400, advisedAmount: 40000 })]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ classification: "ADVICE_MATCH", adviceItemId: "adv1", detectedChange: -400, expectedChange: -400, confidence: "HIGH", status: "SUGGESTED" });
  });

  it("never auto-confirms: every advice match is SUGGESTED", () => {
    const out = run([h("A", 1000)], [h("A", 0)], [advice({ id: "x", securityId: "A", action: "SELL", advisedAmount: 100000 })]);
    expect(out.every((p) => p.status === "SUGGESTED")).toBe(true);
  });

  it("flags a reduction with no matching advice as UNADVISED", () => {
    const out = run([h("X", 5000)], [h("X", 3000)], []);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ classification: "UNADVISED", status: "UNEXPLAINED", changeType: "DECREASE", approxAmount: 200000 });
  });

  it("does not match advice in the wrong direction", () => {
    const out = run([h("A", 1000)], [h("A", 1200)], [advice({ id: "s", securityId: "A", action: "SELL", advisedAmount: 20000 })]);
    expect(out[0].classification).toBe("UNADVISED");
  });

  it("ignores advice issued after the CAS date", () => {
    const later = advice({ id: "late", securityId: "A", action: "SELL", advisedAmount: 40000, communicatedAt: new Date("2026-09-25T10:00:00+05:30") });
    expect(run([h("A", 1000)], [h("A", 600)], [later])[0].classification).toBe("UNADVISED");
  });

  it("marks a partial execution with lower confidence", () => {
    const out = run([h("A", 1000)], [h("A", 800)], [advice({ id: "p", securityId: "A", action: "SELL", advisedAmount: 50000 })]);
    expect(out[0]).toMatchObject({ classification: "ADVICE_MATCH", allocatedUnits: 200, confidence: "LOW" });
    expect(out[0].systemNote).toMatch(/partial/);
  });

  it("allocates across multiple open calls oldest first and caps confidence (ambiguous)", () => {
    const a1 = advice({ id: "old", securityId: "A", action: "SELL", advisedAmount: 30000, communicatedAt: new Date("2026-09-01T10:00:00+05:30") });
    const a2 = advice({ id: "new", securityId: "A", action: "SELL", advisedAmount: 20000, communicatedAt: new Date("2026-09-05T10:00:00+05:30") });
    const out = run([h("A", 1000)], [h("A", 500)], [a2, a1]);
    expect(out.map((o) => [o.adviceItemId, o.allocatedUnits])).toEqual([["old", 300], ["new", 200]]);
    expect(out.every((o) => o.confidence === "MEDIUM")).toBe(true);
  });

  it("reports the excess beyond advice as UNADVISED", () => {
    const out = run([h("A", 1000)], [h("A", 300)], [advice({ id: "a", securityId: "A", action: "SELL", advisedAmount: 40000 })]);
    const unadvised = out.find((o) => o.classification === "UNADVISED");
    expect(unadvised?.allocatedUnits).toBe(300);
  });

  it("explains increases by SIP instalments from the CAS transaction list", () => {
    const out = run([h("S", 500)], [h("S", 520)], [], [
      { securityId: "S", isin: null, schemeName: "Fund S", type: "SIP", units: 10, date: "2026-09-05" },
      { securityId: "S", isin: null, schemeName: "Fund S", type: "SIP", units: 10, date: "2026-09-15" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ classification: "SIP_INSTALMENT", allocatedUnits: 20 });
  });

  it("includes executions recorded manually but not CAS-verified (no double counting)", () => {
    const executed = advice({
      id: "done", securityId: "B", action: "BUY", status: "EXECUTED", advisedAmount: 100000,
      executedAmount: 100000, unverifiedExecutedAmount: 100000,
    });
    const out = run([], [h("B", 1000, 100)], [executed]);
    expect(out[0]).toMatchObject({ classification: "ADVICE_MATCH", adviceItemId: "done", confidence: "HIGH", changeType: "NEW_HOLDING" });
  });

  it("is HIGH when the CAS shows exactly the manually recorded part of a partly executed call", () => {
    const part = advice({
      id: "part", securityId: "C", action: "SELL", status: "PARTIALLY_EXECUTED", quantityBasis: "UNITS", advisedUnits: 200,
      advisedAmount: 20000, executedUnits: 120, executedAmount: 12000, unverifiedExecutedUnits: 120, unverifiedExecutedAmount: 12000,
    });
    const out = run([h("C", 400)], [h("C", 280)], [part]);
    expect(out[0]).toMatchObject({ confidence: "HIGH", allocatedUnits: 120 });
    expect(out[0].systemNote).toMatch(/already recorded/);
  });

  it("aggregates multiple folios of the same security", () => {
    const prev = [h("A", 600), { ...h("A", 400), folioNumber: "F2" }];
    const out = run(prev, [h("A", 600)], [advice({ id: "a", securityId: "A", action: "SELL", advisedAmount: 40000 })]);
    expect(out[0]).toMatchObject({ detectedChange: -400, confidence: "HIGH" });
    expect(out[0].folioNumbers).toEqual(["F1", "F2"]);
  });
});
