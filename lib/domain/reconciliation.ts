/**
 * CAS reconciliation engine (pure, deterministic, unit-tested).
 *
 * Compares two portfolio snapshots, detects unit changes per security and
 * proposes matches against advice items. It NEVER finalises anything: its
 * output is a list of proposals that a person confirms / rejects (RULE 6).
 *
 * Expected change for an advice item = the part not yet evidenced by a CAS:
 *   open pending quantity + executions recorded manually but not CAS-verified.
 * This prevents double counting when an advisor already recorded an execution
 * that the new CAS now shows.
 */

export const ENGINE_VERSION = "v1";

export interface HoldingLine {
  securityId: string | null;
  isin: string | null;
  schemeName: string;
  folioNumber: string | null;
  units: number;
  currentValue: number;
  nav: number | null;
}

export interface CandidateAdvice {
  id: string;
  securityId: string;
  action: "BUY" | "SELL" | "SWITCH";
  status: "ISSUED" | "PARTIALLY_EXECUTED" | "EXECUTED";
  quantityBasis: "AMOUNT" | "UNITS";
  advisedAmount: number;
  advisedUnits: number | null;
  executedAmount: number;
  executedUnits: number;
  unverifiedExecutedAmount: number;
  unverifiedExecutedUnits: number;
  referencePrice: number | null;
  communicatedAt: Date;
}

export interface CasTxnLine {
  securityId: string | null;
  isin: string | null;
  schemeName: string;
  type: string;
  units: number | null;
  date: string; // YYYY-MM-DD
}

export type ChangeType = "INCREASE" | "DECREASE" | "NEW_HOLDING" | "EXITED";
export type Classification = "ADVICE_MATCH" | "SIP_INSTALMENT" | "UNADVISED";
export type Confidence = "HIGH" | "MEDIUM" | "LOW" | "NONE";

export interface MatchProposal {
  key: string;
  securityId: string | null;
  schemeName: string;
  folioNumbers: string[];
  changeType: ChangeType;
  classification: Classification;
  adviceItemId: string | null;
  previousUnits: number;
  currentUnits: number;
  detectedChange: number; // signed units, whole security
  previousValue: number;
  currentValue: number;
  referenceNav: number | null;
  approxAmount: number; // rupees for the allocated part (or whole change)
  allocatedUnits: number | null; // unsigned units allocated to this row
  expectedChange: number | null; // signed units expected from advice
  expectedAmount: number | null; // rupees expected from advice
  confidence: Confidence;
  status: "SUGGESTED" | "UNEXPLAINED";
  systemNote: string;
}

export interface EngineInput {
  previous: HoldingLine[];
  current: HoldingLine[];
  advice: CandidateAdvice[];
  /** CAS transactions dated after the previous snapshot, up to the current one. */
  transactions: CasTxnLine[];
  currentSnapshotDate: string; // YYYY-MM-DD
}

const UNIT_EPSILON = 0.001;

export function normaliseName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function holdingKey(h: { securityId: string | null; isin: string | null; schemeName: string }): string {
  if (h.securityId) return `sec:${h.securityId}`;
  if (h.isin) return `isin:${h.isin}`;
  return `name:${normaliseName(h.schemeName)}`;
}

interface Aggregate {
  key: string;
  securityId: string | null;
  schemeName: string;
  folios: Set<string>;
  units: number;
  value: number;
  nav: number | null;
}

function aggregate(lines: HoldingLine[]): Map<string, Aggregate> {
  const map = new Map<string, Aggregate>();
  for (const l of lines) {
    const key = holdingKey(l);
    const agg = map.get(key) ?? {
      key, securityId: l.securityId, schemeName: l.schemeName, folios: new Set<string>(), units: 0, value: 0, nav: null,
    };
    agg.units += Number(l.units) || 0;
    agg.value += Number(l.currentValue) || 0;
    if (l.folioNumber) agg.folios.add(l.folioNumber);
    if (l.nav && l.nav > 0) agg.nav = l.nav;
    map.set(key, agg);
  }
  for (const agg of map.values()) {
    if (!agg.nav && agg.units > 0) agg.nav = agg.value / agg.units;
  }
  return map;
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Units a candidate advice item is still expected to show in a CAS. */
export function expectedUnitsFor(a: CandidateAdvice, nav: number | null): { units: number; amount: number } {
  const isOpen = a.status === "ISSUED" || a.status === "PARTIALLY_EXECUTED";
  if (a.quantityBasis === "UNITS" && a.advisedUnits) {
    const pendingUnits = isOpen ? Math.max(a.advisedUnits - a.executedUnits, 0) : 0;
    const units = pendingUnits + a.unverifiedExecutedUnits;
    const price = nav ?? a.referencePrice ?? 0;
    return { units, amount: units * price };
  }
  const pendingAmount = isOpen ? Math.max(a.advisedAmount - a.executedAmount, 0) : 0;
  const amount = pendingAmount + a.unverifiedExecutedAmount;
  const price = nav ?? a.referencePrice;
  return { units: price ? amount / price : 0, amount };
}

function confidenceFor(ratio: number, basis: "AMOUNT" | "UNITS", ambiguous: boolean): Confidence {
  const deviation = Math.abs(1 - ratio);
  let c: Confidence;
  if (deviation <= (basis === "UNITS" ? 0.005 : 0.03)) c = "HIGH";
  else if (deviation <= 0.1) c = "MEDIUM";
  else c = "LOW";
  if (ambiguous && c === "HIGH") c = "MEDIUM";
  return c;
}

export function reconcile(input: EngineInput): MatchProposal[] {
  const prev = aggregate(input.previous);
  const curr = aggregate(input.current);
  const keys = new Set([...prev.keys(), ...curr.keys()]);
  const cutoff = new Date(`${input.currentSnapshotDate}T23:59:59.999+05:30`).getTime();
  const proposals: MatchProposal[] = [];

  for (const key of keys) {
    const p = prev.get(key);
    const c = curr.get(key);
    const prevUnits = round4(p?.units ?? 0);
    const currUnits = round4(c?.units ?? 0);
    const delta = round4(currUnits - prevUnits);
    if (Math.abs(delta) < UNIT_EPSILON) continue;

    const securityId = c?.securityId ?? p?.securityId ?? null;
    const schemeName = c?.schemeName ?? p?.schemeName ?? "Unknown scheme";
    const nav = c?.nav ?? p?.nav ?? null;
    const changeType: ChangeType =
      prevUnits <= UNIT_EPSILON ? "NEW_HOLDING" : currUnits <= UNIT_EPSILON ? "EXITED" : delta > 0 ? "INCREASE" : "DECREASE";

    const base = {
      key,
      securityId,
      schemeName,
      folioNumbers: [...new Set([...(p?.folios ?? []), ...(c?.folios ?? [])])].sort(),
      changeType,
      previousUnits: prevUnits,
      currentUnits: currUnits,
      detectedChange: delta,
      previousValue: round2(p?.value ?? 0),
      currentValue: round2(c?.value ?? 0),
      referenceNav: nav,
    };

    // 1) SIP instalments visible in the CAS explain (part of) an increase.
    let residual = Math.abs(delta);
    if (delta > 0) {
      const sipUnits = input.transactions
        .filter((t) => t.type === "SIP" && holdingKey(t) === key && (t.units ?? 0) > 0)
        .reduce((s, t) => s + (t.units ?? 0), 0);
      if (sipUnits > UNIT_EPSILON) {
        const explained = Math.min(sipUnits, residual);
        proposals.push({
          ...base,
          classification: "SIP_INSTALMENT",
          adviceItemId: null,
          approxAmount: round2(explained * (nav ?? 0)),
          allocatedUnits: round4(explained),
          expectedChange: null,
          expectedAmount: null,
          confidence: "HIGH",
          status: "UNEXPLAINED",
          systemNote: `Explained by ${round4(sipUnits)} units of SIP instalments in the CAS transaction list.`,
        });
        residual = round4(residual - explained);
        if (residual < Math.max(UNIT_EPSILON, Math.abs(delta) * 0.01)) continue;
      }
    }

    // 2) Candidate advice in the same direction for the same security.
    const wantSell = delta < 0;
    const candidates = input.advice
      .filter((a) => securityId !== null && a.securityId === securityId)
      .filter((a) => (wantSell ? a.action === "SELL" || a.action === "SWITCH" : a.action === "BUY"))
      .filter((a) => a.communicatedAt.getTime() <= cutoff)
      .map((a) => ({ advice: a, expected: expectedUnitsFor(a, nav) }))
      .filter((x) => x.expected.units > UNIT_EPSILON)
      .sort((x, y) => x.advice.communicatedAt.getTime() - y.advice.communicatedAt.getTime());

    const ambiguous = candidates.length > 1;
    let remaining = residual;
    for (const { advice, expected } of candidates) {
      if (remaining <= UNIT_EPSILON) break;
      const allocated = Math.min(expected.units, remaining);
      remaining = round4(remaining - allocated);
      const ratio = allocated / expected.units;
      // The CAS may evidence exactly the executions already recorded manually,
      // with the rest of the call still pending: that is a clean match too.
      const unverifiedUnits =
        advice.quantityBasis === "UNITS" ? advice.unverifiedExecutedUnits : nav ? advice.unverifiedExecutedAmount / nav : 0;
      const matchesRecorded = unverifiedUnits > UNIT_EPSILON && ratio < 0.97 &&
        confidenceFor(allocated / unverifiedUnits, advice.quantityBasis, false) === "HIGH";
      const confidence = matchesRecorded ? (ambiguous ? "MEDIUM" : "HIGH") : confidenceFor(ratio, advice.quantityBasis, ambiguous);
      const sign = wantSell ? -1 : 1;
      const partial = ratio < 0.97;
      proposals.push({
        ...base,
        classification: "ADVICE_MATCH",
        adviceItemId: advice.id,
        approxAmount: round2(allocated * (nav ?? advice.referencePrice ?? 0)),
        allocatedUnits: round4(allocated),
        expectedChange: round4(sign * expected.units),
        expectedAmount: round2(expected.amount),
        confidence,
        status: "SUGGESTED",
        systemNote: [
          `${wantSell ? "Reduction" : "Increase"} of ${round4(allocated)} units vs ${round4(expected.units)} expected`,
          matchesRecorded ? "(matches executions already recorded; remainder of the call still pending)" : partial ? "(looks like a partial execution)" : "",
          ambiguous ? `— ${candidates.length} open calls on this security, allocated oldest first` : "",
          advice.unverifiedExecutedAmount > 0 ? "— includes executions recorded manually, awaiting CAS verification" : "",
        ].filter(Boolean).join(" "),
      });
    }

    // 3) Whatever is left has no matching advice: UNADVISED activity.
    if (remaining > Math.max(UNIT_EPSILON, residual * 0.01)) {
      proposals.push({
        ...base,
        classification: "UNADVISED",
        adviceItemId: null,
        approxAmount: round2(remaining * (nav ?? 0)),
        allocatedUnits: round4(remaining),
        expectedChange: null,
        expectedAmount: null,
        confidence: "NONE",
        status: "UNEXPLAINED",
        systemNote:
          candidates.length > 0
            ? `${round4(remaining)} units exceed what open advice explains.`
            : `No matching advice. Approx. ${delta < 0 ? "reduction" : "increase"} of ₹${Math.round(remaining * (nav ?? 0)).toLocaleString("en-IN")}.`,
      });
    }
  }

  return proposals.sort((a, b) => a.schemeName.localeCompare(b.schemeName));
}
