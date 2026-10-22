/**
 * Approve waiting: what one ticked line on the "Approve waiting" page turns into. Pure, so the
 * page, the server action and the tests agree.
 *
 * A waiting call can be:
 *   DONE    → an execution for everything still waiting (units for a unit call, else the amount)
 *   PART    → an execution for less than that; the rest stays waiting on the call
 *   REVISE  → a new advised total (the call is revised, as on the call page)
 *   CANCEL  → the rest of the call is cancelled, with a reason
 * A waiting SIP line can be STARTED (counted as running) or CANCEL.
 * "Not yet" lines are simply not sent.
 */

export type CallChoice = "DONE" | "PART" | "REVISE" | "CANCEL";
export type SipChoice = "STARTED" | "CANCEL";

export interface WaitingCallFacts {
  quantityBasis: "AMOUNT" | "UNITS";
  advisedAmount: number;
  advisedUnits: number | null;
  executedAmount: number;
  executedUnits: number;
  pendingAmount: number;
  pendingUnits: number | null;
}

export interface LineInput {
  choice: string;
  /** Typed by the person: "₹1,50,000", "150000", "" … */
  amount?: string | null;
  units?: string | null;
  /** YYYY-MM-DD; empty = today. */
  date?: string | null;
  reason?: string | null;
}

export type CallOp =
  | { op: "EXECUTE"; amount: number; units: number | null; date: string; partial: boolean }
  | { op: "REVISE"; newTotalAmount: number; newTotalUnits: number | null; reason: string }
  | { op: "CANCEL"; reason: string };

export type SipOp = { op: "SIP_STARTED"; date: string } | { op: "SIP_CANCEL"; reason: string };

export class LineError extends Error {}

const r2 = (v: number) => Math.round(v * 100) / 100;
const r4 = (v: number) => Math.round(v * 10000) / 10000;

/** "₹1,50,000.50" → 150000.5; empty → null; anything else that is not a positive number → error. */
export function parseNumber(raw: string | null | undefined, what: string): number | null {
  const s = String(raw ?? "").replace(/[₹,\s]/g, "").replace(/u(nits)?$/i, "");
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) throw new LineError(`Enter the ${what} as a number above zero.`);
  return n;
}

function dateOf(raw: string | null | undefined, today: string): string {
  const d = String(raw ?? "").trim() || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d))) throw new LineError("Enter the date as YYYY-MM-DD.");
  if (d > today) throw new LineError("The date cannot be in the future.");
  return d;
}

function reasonOf(raw: string | null | undefined, what: string): string {
  const r = String(raw ?? "").trim();
  if (!r) throw new LineError(`Give a reason to ${what}.`);
  return r.slice(0, 500);
}

export function callOp(c: WaitingCallFacts, input: LineInput, today: string): CallOp {
  const units = c.quantityBasis === "UNITS";
  switch (input.choice) {
    case "DONE": {
      const date = dateOf(input.date, today);
      const amount = parseNumber(input.amount, "amount") ?? r2(c.pendingAmount);
      if (units) {
        const u = c.pendingUnits ?? 0;
        if (!(u > 0)) throw new LineError("No units are left on this call.");
        return { op: "EXECUTE", amount, units: r4(u), date, partial: false };
      }
      if (!(amount > 0)) throw new LineError("Nothing is left to do on this call.");
      return { op: "EXECUTE", amount, units: parseNumber(input.units, "units"), date, partial: false };
    }
    case "PART": {
      const date = dateOf(input.date, today);
      if (units) {
        const u = parseNumber(input.units, "units");
        if (u == null) throw new LineError("Enter the units done.");
        const left = c.pendingUnits ?? 0;
        if (u >= left - 0.0001) throw new LineError("That is all of it: choose Done.");
        const amount = parseNumber(input.amount, "amount") ?? r2(left > 0 ? (c.pendingAmount * u) / left : 0);
        return { op: "EXECUTE", amount, units: r4(u), date, partial: true };
      }
      const amount = parseNumber(input.amount, "amount");
      if (amount == null) throw new LineError("Enter the amount done.");
      if (amount >= c.pendingAmount - 0.5) throw new LineError("That is all of it: choose Done.");
      return { op: "EXECUTE", amount, units: parseNumber(input.units, "units"), date, partial: true };
    }
    case "REVISE": {
      const reason = reasonOf(input.reason, "revise");
      if (units) {
        const u = parseNumber(input.units, "new units");
        if (u == null) throw new LineError("Enter the new number of units for the call.");
        if (u <= c.executedUnits) throw new LineError("The new units must be more than what is already done.");
        if (c.advisedUnits != null && Math.abs(u - c.advisedUnits) < 0.0001) throw new LineError("That is the same as advised.");
        // The amount moves with the units at the call's own price.
        const price = c.advisedUnits ? c.advisedAmount / c.advisedUnits : 0;
        const a = parseNumber(input.amount, "new amount") ?? r2(u * price);
        if (!(a > c.executedAmount)) throw new LineError("Enter the new amount for the call as well.");
        return { op: "REVISE", newTotalAmount: a, newTotalUnits: r4(u), reason };
      }
      const a = parseNumber(input.amount, "new amount");
      if (a == null) throw new LineError("Enter the new amount for the call.");
      if (a <= c.executedAmount) throw new LineError("The new amount must be more than what is already done.");
      if (Math.abs(a - c.advisedAmount) < 0.5) throw new LineError("That is the same as advised.");
      return { op: "REVISE", newTotalAmount: r2(a), newTotalUnits: null, reason };
    }
    case "CANCEL":
      return { op: "CANCEL", reason: reasonOf(input.reason, "cancel") };
    default:
      throw new LineError("Choose Done, Part done, Revise or Cancel.");
  }
}

export function sipOp(input: LineInput, today: string): SipOp {
  if (input.choice === "STARTED") return { op: "SIP_STARTED", date: dateOf(input.date, today) };
  if (input.choice === "CANCEL") return { op: "SIP_CANCEL", reason: reasonOf(input.reason, "cancel") };
  throw new LineError("Choose Started or Cancel.");
}

/** Note kept on a hand-recorded execution / SIP line approved from the waiting page. */
export const APPROVED_NOTE = "Approved on the waiting page";

export interface MoneyParts {
  /** Live value of the holdings (latest CAS units × today's NAV). */
  liveFunds: number;
  /** In bank as per the CAS figures only. */
  bankCas: number;
  approvedSold: number;
  approvedBought: number;
}

/**
 * Money in three layers: as per the last CAS, + approved since (not in a CAS yet), = now (estimated).
 * Never below zero: a buy bigger than the bank was paid from outside.
 */
export function moneyNow(m: MoneyParts) {
  const fundsDelta = m.approvedBought - m.approvedSold;
  const bankDelta = m.approvedSold - m.approvedBought;
  return {
    cas: { funds: m.liveFunds, bank: m.bankCas },
    approved: { funds: fundsDelta, bank: bankDelta },
    now: { funds: Math.max(0, m.liveFunds + fundsDelta), bank: Math.max(0, m.bankCas + bankDelta) },
    hasApproved: Math.abs(m.approvedSold) >= 0.5 || Math.abs(m.approvedBought) >= 0.5,
  };
}

/** Where the money ends up if some more sells and buys happen (waiting calls, or the rest of the plan). */
export function moneyAfter(now: { funds: number; bank: number }, sells: number, buys: number) {
  return { funds: Math.max(0, now.funds - sells + buys), bank: Math.max(0, now.bank + sells - buys) };
}
