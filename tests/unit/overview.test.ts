import { describe, expect, it } from "vitest";
import { clientStatus, nextAction, periodRange, proofOf, type BookClient } from "@/lib/domain/overview";

const base: BookClient = {
  has_plan: true, has_draft: false, draft_days: null, pending: 0, executed: 0, left_to_advise: 0, open_calls: 0,
  oldest_wait_days: null, cas_after_oldest: false, cas_to_check: 0, trades_to_decide: 0, in_bank: 0, buy_left: 0, follow_ups: 0,
};

describe("periodRange", () => {
  it("starts on the first day of the period's first month, across a year end", () => {
    expect(periodRange("month", "2026-10-22")).toEqual({ from: "2026-10-01", to: "2026-10-22", months: 1 });
    expect(periodRange("3m", "2026-02-05")).toEqual({ from: "2025-12-01", to: "2026-02-05", months: 3 });
    expect(periodRange("12m", "2026-10-22").from).toBe("2025-11-01");
    expect(periodRange("nonsense", "2026-10-22").from).toBe("2026-10-01");
  });
});

describe("clientStatus / nextAction", () => {
  it("puts behind clients first and names one next step in the desk's order", () => {
    const behind = { ...base, pending: 300000, executed: 0, open_calls: 3, oldest_wait_days: 34 };
    expect(clientStatus(behind)).toMatchObject({ label: "Behind · 34 days", rank: 0 });
    expect(nextAction(behind)).toBe("Ask for CAS (34 days)");
    expect(nextAction({ ...behind, cas_after_oldest: true })).toBe("Approve 3 waiting calls");
    expect(nextAction({ ...behind, cas_to_check: 1 })).toBe("Check the new CAS");
    expect(clientStatus({ ...base, pending: 1000, executed: 5000, oldest_wait_days: 5 }).label).toBe("Part done");
    expect(clientStatus({ ...base, pending: 1000, oldest_wait_days: 5 }).label).toBe("Waiting");
  });
  it("draft, idle cash, next tranche, done", () => {
    expect(clientStatus({ ...base, has_plan: false, has_draft: true }).label).toBe("Draft");
    expect(nextAction({ ...base, has_plan: false, has_draft: true, draft_days: 8 })).toBe("Approve draft (8 days)");
    expect(nextAction({ ...base, in_bank: 800000, buy_left: 2500000, left_to_advise: 2500000 })).toBe("Advise buys: ₹8L idle");
    expect(clientStatus({ ...base, left_to_advise: 100 }).label).toBe("Next tranche");
    expect(clientStatus(base).label).toBe("Done");
    expect(nextAction(base)).toBe("—");
  });
});

describe("proofOf", () => {
  it("maps each execution to its proof", () => {
    expect(proofOf({ verification_type: "CAS_VERIFIED", cas_verified: true })).toBe("CAS");
    expect(proofOf({ verification_type: "ADVISOR_CONFIRMED", cas_verified: true })).toBe("CAS");
    expect(proofOf({ verification_type: "ADVISOR_CONFIRMED", cas_verified: false })).toBe("APPROVED");
    expect(proofOf({ verification_type: "PROOF_VERIFIED", cas_verified: false })).toBe("PRE");
  });
});
