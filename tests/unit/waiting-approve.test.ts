import { describe, expect, it } from "vitest";
import { callOp, moneyAfter, moneyNow, parseNumber, sipOp } from "@/lib/domain/waiting-approve";

const today = "2026-10-22";
const amountCall = { quantityBasis: "AMOUNT" as const, advisedAmount: 200000, advisedUnits: null, executedAmount: 0, executedUnits: 0, pendingAmount: 200000, pendingUnits: null };
const unitCall = { quantityBasis: "UNITS" as const, advisedAmount: 99000, advisedUnits: 825, executedAmount: 0, executedUnits: 0, pendingAmount: 99000, pendingUnits: 825 };

describe("callOp", () => {
  it("Done records everything still waiting: the amount, or all units of a unit call", () => {
    expect(callOp(amountCall, { choice: "DONE" }, today)).toEqual({ op: "EXECUTE", amount: 200000, units: null, date: today, partial: false });
    expect(callOp(unitCall, { choice: "DONE", amount: "₹98,500", date: "2026-10-21" }, today)).toEqual({ op: "EXECUTE", amount: 98500, units: 825, date: "2026-10-21", partial: false });
  });

  it("Part done needs less than what is waiting; a unit call prices the part at the call's own rate", () => {
    expect(callOp(amountCall, { choice: "PART", amount: "60,000" }, today)).toMatchObject({ op: "EXECUTE", amount: 60000, partial: true });
    expect(callOp(unitCall, { choice: "PART", units: "500" }, today)).toMatchObject({ amount: 60000, units: 500, partial: true });
    expect(() => callOp(amountCall, { choice: "PART", amount: "200000" }, today)).toThrow(/choose Done/);
    expect(() => callOp(unitCall, { choice: "PART" }, today)).toThrow(/units done/);
  });

  it("Revise takes a new total (more than done, not the same); a unit call moves its amount with the units", () => {
    expect(callOp(amountCall, { choice: "REVISE", amount: "150000", reason: "Client's choice" }, today)).toEqual({ op: "REVISE", newTotalAmount: 150000, newTotalUnits: null, reason: "Client's choice" });
    expect(callOp(unitCall, { choice: "REVISE", units: "412.5", reason: "Half" }, today)).toEqual({ op: "REVISE", newTotalAmount: 49500, newTotalUnits: 412.5, reason: "Half" });
    expect(() => callOp(amountCall, { choice: "REVISE", amount: "150000" }, today)).toThrow(/reason/);
    expect(() => callOp(amountCall, { choice: "REVISE", amount: "200000", reason: "x" }, today)).toThrow(/same as advised/);
    expect(() => callOp({ ...amountCall, executedAmount: 160000, pendingAmount: 40000 }, { choice: "REVISE", amount: "150000", reason: "x" }, today)).toThrow(/more than what is already done/);
  });

  it("Cancel needs a reason; dates cannot be in the future; unknown choices are refused", () => {
    expect(callOp(amountCall, { choice: "CANCEL", reason: "Client declined" }, today)).toEqual({ op: "CANCEL", reason: "Client declined" });
    expect(() => callOp(amountCall, { choice: "CANCEL", reason: " " }, today)).toThrow(/reason/);
    expect(() => callOp(amountCall, { choice: "DONE", date: "2026-10-23" }, today)).toThrow(/future/);
    expect(() => callOp(amountCall, { choice: "DONE", date: "23-10-2026" }, today)).toThrow(/YYYY-MM-DD/);
    expect(() => callOp(amountCall, { choice: "MAYBE" }, today)).toThrow(/Choose/);
  });
});

describe("sipOp and parseNumber", () => {
  it("SIP lines are started or cancelled", () => {
    expect(sipOp({ choice: "STARTED" }, today)).toEqual({ op: "SIP_STARTED", date: today });
    expect(() => sipOp({ choice: "CANCEL" }, today)).toThrow(/reason/);
  });
  it("reads rupees and units as typed", () => {
    expect(parseNumber("₹ 1,50,000.50", "amount")).toBe(150000.5);
    expect(parseNumber("3,241.474 u", "units")).toBe(3241.474);
    expect(parseNumber("", "amount")).toBeNull();
    expect(() => parseNumber("-5", "amount")).toThrow(/above zero/);
  });
});

describe("moneyNow / moneyAfter", () => {
  it("last CAS + approved = now; never below zero", () => {
    const m = moneyNow({ liveFunds: 2940000, bankCas: 0, approvedSold: 450000, approvedBought: 200000 });
    expect(m.approved).toEqual({ funds: -250000, bank: 250000 });
    expect(m.now).toEqual({ funds: 2690000, bank: 250000 });
    expect(m.hasApproved).toBe(true);
    expect(moneyNow({ liveFunds: 100, bankCas: 0, approvedSold: 0, approvedBought: 500 }).now).toEqual({ funds: 600, bank: 0 });
    expect(moneyAfter(m.now, 39000, 220000)).toEqual({ funds: 2871000, bank: 69000 });
  });
});
