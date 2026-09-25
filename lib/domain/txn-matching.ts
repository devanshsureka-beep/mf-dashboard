/**
 * Transaction-level reconciliation (pure, unit-tested).
 *
 * A detailed CAS lists every redemption / purchase with its date, amount,
 * units and NAV. This engine matches each NEW CAS transaction to the calls
 * that were given before it, so the dashboard can say:
 *   "SELL ₹3L advised 24-Sep 10:30 → redeemed ₹2,98,640 on 24-Sep (same day)".
 *
 * Decisions (agreed with the business, 2026-09-25):
 *   - Clear matches are auto-confirmed (same security, same direction, dated on
 *     or after the call, within 30 days, amount within 3% or a partial fill).
 *   - Anything else is proposed for review; transactions with no call are
 *     UNADVISED and always need a person to acknowledge them.
 *   - SIP instalments and SIP cancellations never satisfy lump-sum calls; they
 *     are reported separately (and tick off SIP start/stop plan items).
 */

export const TOLERANCE = 0.03; // NAV drift between call and execution
export const AUTO_CONFIRM_MAX_LAG_DAYS = 30;

export type TxnKind = "SELL" | "BUY" | "SIP" | "SIP_CANCELLED" | "IGNORE";

export interface MatchCall {
  id: string;
  securityId: string;
  isin: string | null;
  action: "BUY" | "SELL" | "SWITCH";
  status: "ISSUED" | "PARTIALLY_EXECUTED" | "EXECUTED";
  quantityBasis: "AMOUNT" | "UNITS";
  advisedAmount: number;
  advisedUnits: number | null;
  executedAmount: number;
  executedUnits: number;
  /** Executions recorded manually (client/advisor confirmed) not yet evidenced by a CAS. */
  unverifiedExecutedAmount: number;
  unverifiedExecutedUnits: number;
  communicatedAt: Date;
}

export interface MatchTxn {
  id: string;
  securityId: string | null;
  isin: string | null;
  schemeName: string;
  date: string; // YYYY-MM-DD
  type: string;
  description: string | null;
  amount: number | null; // signed as in the CAS
  units: number | null; // signed as in the CAS
  nav: number | null;
}

export interface TxnProposal {
  txnId: string;
  callId: string | null;
  securityId: string | null;
  schemeName: string;
  kind: "ADVICE_MATCH" | "SIP_INSTALMENT" | "SIP_CANCELLED" | "UNADVISED";
  direction: "SELL" | "BUY" | null;
  date: string;
  txnAmount: number; // absolute
  txnUnits: number; // absolute
  nav: number | null;
  allocatedAmount: number; // absolute, part of this txn attributed to this row
  allocatedUnits: number;
  expectedAmount: number | null; // what the call still expected (amount)
  lagDays: number | null;
  confidence: "HIGH" | "MEDIUM" | "LOW" | "NONE";
  autoConfirm: boolean;
  note: string;
}

export function txnKind(t: Pick<MatchTxn, "type" | "description">): TxnKind {
  if (t.type === "REDEMPTION" || t.type === "SWITCH_OUT") return "SELL";
  if (t.type === "PURCHASE" || t.type === "SWITCH_IN") return "BUY";
  if (t.type === "SIP") return "SIP";
  if (t.type === "OTHER" && /sip\s*cancel/i.test(t.description ?? "")) return "SIP_CANCELLED";
  return "IGNORE";
}

export function istDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(d);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

interface Capacity {
  call: MatchCall;
  remaining: number; // in the call's own basis (rupees or units)
  initial: number;
}

function capacityOf(c: MatchCall): number {
  const open = c.status === "ISSUED" || c.status === "PARTIALLY_EXECUTED";
  if (c.quantityBasis === "UNITS" && c.advisedUnits) {
    return (open ? Math.max(c.advisedUnits - c.executedUnits, 0) : 0) + c.unverifiedExecutedUnits;
  }
  return (open ? Math.max(c.advisedAmount - c.executedAmount, 0) : 0) + c.unverifiedExecutedAmount;
}

const sameSecurity = (c: MatchCall, t: MatchTxn) =>
  (t.securityId !== null && c.securityId === t.securityId) || (t.isin !== null && c.isin !== null && c.isin === t.isin);

export function matchTransactions(calls: MatchCall[], txns: MatchTxn[]): TxnProposal[] {
  const caps: Capacity[] = calls
    .map((call) => ({ call, remaining: capacityOf(call), initial: capacityOf(call) }))
    .filter((c) => c.remaining > 0.0001)
    .sort((a, b) => a.call.communicatedAt.getTime() - b.call.communicatedAt.getTime());

  const out: TxnProposal[] = [];
  const sorted = [...txns].sort((a, b) => a.date.localeCompare(b.date));

  for (const t of sorted) {
    const kind = txnKind(t);
    if (kind === "IGNORE") continue;
    const txnAmount = r2(Math.abs(t.amount ?? 0));
    const txnUnits = r4(Math.abs(t.units ?? 0));
    const nav = t.nav ?? (txnUnits > 0 ? txnAmount / txnUnits : null);
    const base = {
      txnId: t.id, securityId: t.securityId, schemeName: t.schemeName, date: t.date,
      txnAmount, txnUnits, nav,
    };

    if (kind === "SIP" || kind === "SIP_CANCELLED") {
      out.push({
        ...base, callId: null, kind: kind === "SIP" ? "SIP_INSTALMENT" : "SIP_CANCELLED", direction: kind === "SIP" ? "BUY" : null,
        allocatedAmount: txnAmount, allocatedUnits: txnUnits, expectedAmount: null, lagDays: null,
        confidence: "HIGH", autoConfirm: false,
        note: kind === "SIP" ? `SIP instalment on ${t.date}.` : `SIP cancelled on ${t.date}.`,
      });
      continue;
    }

    const wantSell = kind === "SELL";
    const candidates = caps.filter((c) =>
      c.remaining > 0.0001 &&
      sameSecurity(c.call, t) &&
      (wantSell ? c.call.action !== "BUY" : c.call.action === "BUY") &&
      istDate(c.call.communicatedAt) <= t.date,
    );

    // Quantity of this txn still to attribute, per basis.
    let leftAmount = txnAmount;
    let leftUnits = txnUnits;
    const split = candidates.length > 1;

    for (const c of candidates) {
      if (leftAmount <= 0.5 && leftUnits <= 0.0005) break;
      const unitsBasis = c.call.quantityBasis === "UNITS" && !!c.call.advisedUnits;
      const txnQtyLeft = unitsBasis ? leftUnits : leftAmount;
      if (txnQtyLeft <= 0) continue;
      // Take up to the remaining capacity, absorbing NAV drift within tolerance.
      let take = Math.min(txnQtyLeft, c.remaining);
      const isLastCandidate = c === candidates[candidates.length - 1];
      const overflow = txnQtyLeft - take;
      if (overflow > 0 && overflow <= c.remaining * TOLERANCE + (unitsBasis ? 0.001 : 1) && isLastCandidate) take = txnQtyLeft;
      if (overflow > 0 && overflow <= c.initial * TOLERANCE && !isLastCandidate) take = txnQtyLeft;

      const fraction = txnQtyLeft > 0 ? take / txnQtyLeft : 0;
      const allocAmount = r2(unitsBasis ? leftAmount * fraction : take);
      const allocUnits = r4(unitsBasis ? take : leftUnits * fraction);
      const expected = c.remaining;
      c.remaining = Math.max(c.remaining - take, 0);
      leftAmount = r2(leftAmount - allocAmount);
      leftUnits = r4(leftUnits - allocUnits);

      const lag = daysBetween(istDate(c.call.communicatedAt), t.date);
      const full = take >= expected * (1 - TOLERANCE);
      const confidence: TxnProposal["confidence"] = split ? "MEDIUM" : full ? "HIGH" : "HIGH";
      const auto = lag <= AUTO_CONFIRM_MAX_LAG_DAYS;
      const hadManual = c.call.unverifiedExecutedAmount > 0 || c.call.unverifiedExecutedUnits > 0;
      out.push({
        ...base, callId: c.call.id, kind: "ADVICE_MATCH", direction: wantSell ? "SELL" : "BUY",
        allocatedAmount: allocAmount, allocatedUnits: allocUnits,
        expectedAmount: unitsBasis ? r2(expected * (nav ?? 0)) : r2(expected),
        lagDays: lag, confidence, autoConfirm: auto,
        note: [
          `${wantSell ? "Redeemed" : "Invested"} ₹${allocAmount.toLocaleString("en-IN")} on ${t.date}`,
          lag === 0 ? "(same day as the call)" : `(${lag} day${lag === 1 ? "" : "s"} after the call)`,
          full ? "" : "— partial execution of the call",
          split ? "— one transaction covering several calls, allocated oldest first" : "",
          hadManual ? "— verifies an execution recorded earlier" : "",
          auto ? "" : `— more than ${AUTO_CONFIRM_MAX_LAG_DAYS} days after the call, please review`,
        ].filter(Boolean).join(" "),
      });
    }

    if (leftAmount > 1 || (txnAmount === 0 && leftUnits > 0.001)) {
      const matchedAny = out.some((p) => p.txnId === t.id && p.kind === "ADVICE_MATCH");
      out.push({
        ...base, callId: null, kind: "UNADVISED", direction: wantSell ? "SELL" : "BUY",
        allocatedAmount: leftAmount, allocatedUnits: leftUnits, expectedAmount: null, lagDays: null,
        confidence: "NONE", autoConfirm: false,
        note: matchedAny
          ? `₹${leftAmount.toLocaleString("en-IN")} more than the open call(s) on this fund.`
          : `${wantSell ? "Redemption" : "Purchase"} of ₹${leftAmount.toLocaleString("en-IN")} on ${t.date} with no matching call.`,
      });
    }
  }
  return out;
}
