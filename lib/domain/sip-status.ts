/**
 * SIP status per fund, read from CAS transactions (pure).
 *
 * A CAS has no "SIP registered" table, but every instalment appears as a SIP
 * purchase, and RTAs print cancellations ("SIP Cancelled", "SIP Ceased").
 * As of a date D, a fund's SIP is:
 *   ACTIVE   - an instalment within the last 40 days and no cancellation after it
 *   STOPPED  - instalments in the past, but cancelled or none in the last 40 days
 *   NONE     - never had an instalment
 * Comparing the previous CAS date with the latest one gives what changed.
 */

export interface SipTxn {
  date: string; // YYYY-MM-DD
  type: string; // CAS transaction type (SIP, PURCHASE, OTHER, ...)
  isin: string | null;
  scheme_name: string;
  folio_number: string | null;
  amount: number | null;
  description: string | null;
}

export type SipState = "ACTIVE" | "STOPPED" | "NONE";

export interface SipPoint {
  state: SipState;
  amount: number | null; // latest instalment, rounded
  lastInstalment: string | null;
  cancelledOn: string | null;
  /** Number of SIPs running in this fund/folio. */
  count: number;
}

export type SipChange = "STARTED" | "STOPPED" | "AMOUNT_CHANGED" | "UNCHANGED" | "FIRST_CAS";

export interface SipFundStatus {
  key: string;
  isin: string | null;
  scheme_name: string;
  folio_number: string | null;
  before: SipPoint | null; // null when there is only one CAS
  now: SipPoint;
  change: SipChange;
}

export const ACTIVE_WINDOW_DAYS = 40;

const CANCEL = /\bsip\b.*\b(cancel|ceas|terminat|stopp?ed|closed)|systematic.*\b(cancel|ceas|terminat)/i;
/** Explicitly marked by the RTA / reader as a systematic instalment. */
const EXPLICIT = /sys\.?\s*invest|systematic\s*(investment|purchase|instal)|purchase-?\s*systematic|\bsip\b/i;
const isPurchase = (t: SipTxn) => (t.amount ?? 0) > 0 && (t.type === "SIP" || t.type === "PURCHASE");
const isExplicit = (t: SipTxn) => t.type === "SIP" || EXPLICIT.test(t.description ?? "");

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
/** CAS shows instalments net of stamp duty (₹9,999.50 for ₹10,000): round to ₹50. */
export const roundSip = (amount: number) => Math.round(amount / 50) * 50;
const norm = (f: string | null) => (f ?? "").replace(/[^0-9a-z]/gi, "").toLowerCase();
export const fundKey = (t: { isin: string | null; scheme_name: string; folio_number: string | null }) =>
  `${t.isin ?? t.scheme_name.toLowerCase()}|${norm(t.folio_number)}`;

/** Monthly runs: same rounded amount, 20-40 days apart. */
export const MIN_RUN = 3;

/**
 * Instalments of one fund/folio. Many SIPs (placed through brokers and
 * platforms) appear in the CAS as plain "Purchase" lines, so besides lines the
 * RTA marks as systematic, a run of at least 3 purchases of the same amount
 * about a month apart is treated as a SIP.
 */
export function instalments(txns: SipTxn[]): SipTxn[] {
  const buys = txns.filter(isPurchase).sort((a, b) => a.date.localeCompare(b.date));
  const keep = new Set<SipTxn>(buys.filter(isExplicit));
  const byAmount = new Map<number, SipTxn[]>();
  for (const b of buys) {
    const k = roundSip(b.amount!);
    byAmount.set(k, [...(byAmount.get(k) ?? []), b]);
  }
  for (const series of byAmount.values()) {
    let run: SipTxn[] = [];
    const flush = () => {
      if (run.length >= MIN_RUN) run.forEach((r) => keep.add(r));
      run = [];
    };
    for (const t of series) {
      const prev = run.at(-1);
      if (prev && (daysBetween(prev.date, t.date) < 20 || daysBetween(prev.date, t.date) > 40)) flush();
      run.push(t);
    }
    flush();
  }
  return buys.filter((b) => keep.has(b));
}

/** @deprecated kept for callers that test a single line; prefer instalments(). */
export const isInstalment = (t: SipTxn) => isPurchase(t) && isExplicit(t);

export function sipPointAsOf(txns: SipTxn[], asOf: string): SipPoint {
  const upto = txns.filter((t) => t.date <= asOf).sort((a, b) => a.date.localeCompare(b.date));
  const inst = instalments(upto);
  const cancels = upto.filter((t) => t.description && CANCEL.test(t.description));
  if (!inst.length) return { state: "NONE", amount: null, lastInstalment: null, cancelledOn: cancels.at(-1)?.date ?? null, count: 0 };

  // One SIP per amount; a folio can run several at once (e.g. ₹16,500 on the
  // 8th and ₹11,000 on the 15th). An amount that starts after another one's
  // last instalment replaces it (a changed SIP, not a second one).
  const series = new Map<number, { first: string; last: string }>();
  for (const t of inst) {
    const k = roundSip(t.amount!);
    const s = series.get(k);
    series.set(k, s ? { first: s.first, last: t.date } : { first: t.date, last: t.date });
  }
  const live = [...series.entries()].filter(([amt, s]) =>
    daysBetween(s.last, asOf) <= ACTIVE_WINDOW_DAYS &&
    ![...series.entries()].some(([other, o]) => other !== amt && o.first > s.last));
  const last = inst.at(-1)!;
  const cancelledAfter = cancels.filter((c) => c.date >= last.date).at(-1)?.date ?? null;
  if (live.length && !cancelledAfter) {
    return { state: "ACTIVE", amount: live.reduce((t, [amt]) => t + amt, 0), lastInstalment: last.date, cancelledOn: null, count: live.length };
  }
  return { state: "STOPPED", amount: roundSip(last.amount!), lastInstalment: last.date, cancelledOn: cancelledAfter, count: 0 };
}

export function sipStatus(txns: SipTxn[], latestCasDate: string, previousCasDate: string | null): SipFundStatus[] {
  const groups = new Map<string, SipTxn[]>();
  for (const t of txns) {
    if (!isPurchase(t) && !(t.description && CANCEL.test(t.description))) continue;
    const k = fundKey(t);
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  const out: SipFundStatus[] = [];
  for (const [key, g] of groups) {
    const now = sipPointAsOf(g, latestCasDate);
    const before = previousCasDate ? sipPointAsOf(g, previousCasDate) : null;
    if (now.state === "NONE" && (!before || before.state === "NONE")) continue;
    // Long-finished SIPs (over a year before this CAS, not running before either) are history, not news.
    if (now.state === "STOPPED" && before?.state !== "ACTIVE" && now.lastInstalment && daysBetween(now.lastInstalment, latestCasDate) > 365) continue;
    let change: SipChange = "FIRST_CAS";
    if (before) {
      if (before.state !== "ACTIVE" && now.state === "ACTIVE") change = "STARTED";
      else if (before.state === "ACTIVE" && now.state !== "ACTIVE") change = "STOPPED";
      else if (before.state === "ACTIVE" && now.state === "ACTIVE" && before.amount !== now.amount) change = "AMOUNT_CHANGED";
      else change = "UNCHANGED";
    }
    const latest = [...g].sort((a, b) => a.date.localeCompare(b.date)).at(-1)!;
    out.push({ key, isin: latest.isin, scheme_name: latest.scheme_name, folio_number: latest.folio_number, before, now, change });
  }
  const rank = (s: SipFundStatus) => (s.change === "UNCHANGED" || s.change === "FIRST_CAS" ? 1 : 0);
  return out.sort((a, b) => rank(a) - rank(b) || (b.now.amount ?? 0) - (a.now.amount ?? 0));
}

export interface PlannedSip { action: "START" | "STOP" | "CHANGE"; isin: string | null; new_amount: number | null; old_amount: number | null }

/** Does the CAS show the plan's SIP change done? */
export function planSipMet(plan: PlannedSip, now: SipPoint | null): boolean {
  if (plan.action === "STOP") return !now || now.state !== "ACTIVE";
  if (!now || now.state !== "ACTIVE") return false;
  return plan.new_amount == null || Math.abs((now.amount ?? 0) - plan.new_amount) <= Math.max(50, plan.new_amount * 0.01);
}
