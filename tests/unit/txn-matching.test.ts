import { describe, expect, it } from "vitest";
import { matchTransactions, txnKind, type MatchCall, type MatchTxn } from "@/lib/domain/txn-matching";

const at = (d: string, hm = "10:30") => new Date(`${d}T${hm}:00+05:30`);
const call = (p: Partial<MatchCall> & Pick<MatchCall, "id" | "action">): MatchCall => ({
  securityId: "A", isin: "INF000000001", status: "ISSUED", quantityBasis: "AMOUNT", advisedAmount: 300000, advisedUnits: null,
  executedAmount: 0, executedUnits: 0, unverifiedExecutedAmount: 0, unverifiedExecutedUnits: 0, communicatedAt: at("2026-09-24"), ...p,
});
const txn = (p: Partial<MatchTxn> & Pick<MatchTxn, "id">): MatchTxn => ({
  securityId: "A", isin: "INF000000001", schemeName: "Fund A", date: "2026-09-24", type: "REDEMPTION", description: "Redemption",
  amount: -298640, units: -1245.3, nav: 239.82, ...p,
});

describe("transaction-level matching (CAS proves execution)", () => {
  it("day-1 SELL ₹3L matched to a same-day redemption: auto-confirmed, NAV drift absorbed", () => {
    const [p] = matchTransactions([call({ id: "s1", action: "SELL" })], [txn({ id: "t1" })]);
    expect(p).toMatchObject({ kind: "ADVICE_MATCH", callId: "s1", allocatedAmount: 298640, allocatedUnits: 1245.3, lagDays: 0, confidence: "HIGH", autoConfirm: true });
    expect(p.note).toMatch(/same day/);
  });

  it("day-3 BUY ₹2L executed on day 4 shows a 1-day lag", () => {
    const out = matchTransactions(
      [call({ id: "b1", action: "BUY", securityId: "B", isin: "INF000000002", advisedAmount: 200000, communicatedAt: at("2026-09-26") })],
      [txn({ id: "t2", securityId: "B", isin: "INF000000002", type: "PURCHASE", amount: 199990, units: 812.5, nav: 246.14, date: "2026-09-27" })],
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ callId: "b1", lagDays: 1, autoConfirm: true, allocatedAmount: 199990 });
  });

  it("never matches a transaction dated before the call, nor the wrong direction or fund", () => {
    const calls = [call({ id: "s1", action: "SELL", communicatedAt: at("2026-09-25") })];
    expect(matchTransactions(calls, [txn({ id: "early", date: "2026-09-24" })])[0].kind).toBe("UNADVISED");
    expect(matchTransactions(calls, [txn({ id: "buy", type: "PURCHASE", amount: 5000, date: "2026-09-26" })])[0].kind).toBe("UNADVISED");
    expect(matchTransactions(calls, [txn({ id: "other", securityId: "Z", isin: "INF000000009", date: "2026-09-26" })])[0].kind).toBe("UNADVISED");
  });

  it("partial execution: a smaller redemption is still a confirmed fill; the rest stays pending", () => {
    const [p] = matchTransactions([call({ id: "s1", action: "SELL" })], [txn({ id: "t1", amount: -100000, units: -417 })]);
    expect(p).toMatchObject({ kind: "ADVICE_MATCH", allocatedAmount: 100000, autoConfirm: true });
    expect(p.note).toMatch(/partial/);
  });

  it("excess beyond the call (and tolerance) is reported as unadvised", () => {
    const out = matchTransactions([call({ id: "s1", action: "SELL" })], [txn({ id: "t1", amount: -400000, units: -1668 })]);
    expect(out.map((o) => [o.kind, o.allocatedAmount])).toEqual([["ADVICE_MATCH", 300000], ["UNADVISED", 100000]]);
  });

  it("one redemption covering two calls on the same fund is split oldest first", () => {
    const calls = [
      call({ id: "old", action: "SELL", advisedAmount: 100000, communicatedAt: at("2026-09-20") }),
      call({ id: "new", action: "SELL", advisedAmount: 200000, communicatedAt: at("2026-09-22") }),
    ];
    const out = matchTransactions(calls, [txn({ id: "t", amount: -300000, units: -1250 })]);
    expect(out.map((o) => [o.callId, o.allocatedAmount, o.confidence])).toEqual([["old", 100000, "MEDIUM"], ["new", 200000, "MEDIUM"]]);
  });

  it("unit-based call: 500 units filled by 200 + 300 unit redemptions", () => {
    const c = call({ id: "u", action: "SELL", quantityBasis: "UNITS", advisedUnits: 500, advisedAmount: 25000 });
    const out = matchTransactions([c], [
      txn({ id: "t1", units: -200, amount: -10100, date: "2026-09-24" }),
      txn({ id: "t2", units: -300, amount: -15300, date: "2026-09-25" }),
    ]);
    expect(out.map((o) => [o.txnId, o.allocatedUnits])).toEqual([["t1", 200], ["t2", 300]]);
    expect(out.every((o) => o.kind === "ADVICE_MATCH")).toBe(true);
  });

  it("a manually recorded execution is verified by the CAS, not double counted", () => {
    const c = call({ id: "m", action: "BUY", status: "EXECUTED", advisedAmount: 100000, executedAmount: 100000, unverifiedExecutedAmount: 100000 });
    const [p] = matchTransactions([c], [txn({ id: "t", type: "PURCHASE", amount: 100000, units: 400, date: "2026-09-25" })]);
    expect(p).toMatchObject({ kind: "ADVICE_MATCH", callId: "m", allocatedAmount: 100000 });
    expect(p.note).toMatch(/verifies an execution recorded earlier/);
  });

  it("SIP instalments and cancellations never satisfy lump-sum calls", () => {
    const out = matchTransactions([call({ id: "b", action: "BUY" })], [
      txn({ id: "sip", type: "SIP", amount: 2000, units: 8, date: "2026-10-05" }),
      txn({ id: "cx", type: "OTHER", description: "*** SIP Cancelled ***", amount: null, units: null, date: "2026-10-06" }),
    ]);
    expect(out.map((o) => o.kind)).toEqual(["SIP_INSTALMENT", "SIP_CANCELLED"]);
  });

  it("calls acted on more than 30 days later are proposed for review, not auto-confirmed", () => {
    const [p] = matchTransactions([call({ id: "s", action: "SELL", communicatedAt: at("2026-08-01") })], [txn({ id: "t", date: "2026-09-24" })]);
    expect(p).toMatchObject({ kind: "ADVICE_MATCH", autoConfirm: false, lagDays: 54 });
  });

  it("stamp duty, STT and dividends are ignored", () => {
    expect(txnKind({ type: "STAMP_DUTY", description: null })).toBe("IGNORE");
    expect(txnKind({ type: "STT", description: null })).toBe("IGNORE");
    expect(txnKind({ type: "DIVIDEND_PAYOUT", description: null })).toBe("IGNORE");
    expect(txnKind({ type: "SWITCH_OUT", description: null })).toBe("SELL");
  });
});
