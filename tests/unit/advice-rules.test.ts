import { describe, expect, it } from "vitest";
import { deriveAdviceStatus, overExecution, revisionRemainder } from "@/lib/domain/advice-rules";

const amountCall = (advised: number, executed = 0) => ({
  quantityBasis: "AMOUNT" as const, advisedAmount: advised, advisedUnits: null, executedAmount: executed, executedUnits: 0,
});

describe("advice status derivation (mirrors the database)", () => {
  it("is ISSUED / PARTIALLY_EXECUTED / EXECUTED by executed amount", () => {
    expect(deriveAdviceStatus(amountCall(500000))).toBe("ISSUED");
    expect(deriveAdviceStatus(amountCall(500000, 200000))).toBe("PARTIALLY_EXECUTED");
    expect(deriveAdviceStatus(amountCall(500000, 500000))).toBe("EXECUTED");
  });
  it("treats NAV drift within 1% as fully executed", () => {
    expect(deriveAdviceStatus(amountCall(300000, 298900))).toBe("EXECUTED");
    expect(deriveAdviceStatus(amountCall(300000, 290000))).toBe("PARTIALLY_EXECUTED");
  });
  it("uses units for unit-based calls: 200 + 300 of 500 units", () => {
    const q = { quantityBasis: "UNITS" as const, advisedAmount: 25000, advisedUnits: 500, executedAmount: 10100, executedUnits: 200 };
    expect(deriveAdviceStatus(q)).toBe("PARTIALLY_EXECUTED");
    expect(deriveAdviceStatus({ ...q, executedUnits: 500, executedAmount: 25400 })).toBe("EXECUTED");
  });
});

describe("revision semantics", () => {
  it("new item carries new total minus what was already executed", () => {
    expect(revisionRemainder(amountCall(500000), { amount: 300000 })).toEqual({ amount: 300000, units: null });
    expect(revisionRemainder(amountCall(500000, 100000), { amount: 300000 })).toEqual({ amount: 200000, units: null });
  });
  it("refuses a new total that is not above the executed amount", () => {
    expect(() => revisionRemainder(amountCall(500000, 300000), { amount: 300000 })).toThrow(/greater than the amount already executed/);
  });
  it("requires units for unit-based calls", () => {
    const q = { quantityBasis: "UNITS" as const, advisedAmount: 25000, advisedUnits: 500, executedAmount: 0, executedUnits: 100 };
    expect(() => revisionRemainder(q, { amount: 20000 })).toThrow(/units are required/);
    expect(revisionRemainder(q, { amount: 20000, units: 400 })).toEqual({ amount: 20000, units: 300 });
  });
});

describe("over-execution guard", () => {
  it("allows up to 10% above the call and blocks beyond", () => {
    expect(overExecution(amountCall(100000, 50000), { amount: 60000 }).exceeds).toBe(false);
    expect(overExecution(amountCall(100000, 50000), { amount: 61000 }).exceeds).toBe(true);
  });
});
