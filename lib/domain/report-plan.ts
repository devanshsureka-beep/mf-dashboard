/**
 * Advisory report + CAS holdings -> plan items (pure, unit-tested).
 *
 * - Each SELL/SWITCH row in the report is tied to the CAS holding with the same
 *   folio (and closest fund name), so the plan item carries the ISIN.
 * - Holdings the report does not sell are RETAIN items (tracked, no target).
 * - BUY rows become BUY items; SIP rows become START / STOP / CHANGE items.
 * Anything that cannot be tied with confidence is reported as a warning and
 * the item is flagged for review by the plan screen (never guessed silently).
 */
import type { AdvisoryReportParse } from "@/lib/parsers/advisory-report";
import { detectPlanType, nameSimilarity } from "@/lib/domain/securities";

export interface PlanHolding {
  scheme_name: string;
  isin: string | null;
  folio_number: string | null;
  current_value: number;
  plan_type?: "DIRECT" | "REGULAR" | null;
}

export interface PlanItemDraft {
  action: "SELL" | "SWITCH" | "BUY" | "RETAIN";
  scheme_name: string;
  isin: string | null;
  folio_number: string | null;
  target_amount: number;
  current_amount: number | null;
  reason: string | null;
  priority: number;
  /** For BUY rows: details used to create a name-only security if needed. */
  amc?: string | null;
  plan_type?: "DIRECT" | "REGULAR" | null;
}

export interface SipItemDraft {
  action: "START" | "STOP" | "CHANGE";
  scheme_name: string;
  isin: string | null;
  folio_number: string | null;
  old_amount: number | null;
  new_amount: number | null;
  frequency: "MONTHLY";
  notes: string | null;
  plan_type?: "DIRECT" | "REGULAR" | null;
}

export interface ReportPlanDraft {
  plan_name: string;
  plan_date: string | null;
  starting_portfolio_value: number | null;
  items: PlanItemDraft[];
  sip_items: SipItemDraft[];
  declared_totals: { exit_value: number | null; buy_value: number | null };
  notes: string;
  warnings: string[];
}

/** "HDFC Flexi Cap Fund" + DIRECT -> "HDFC Flexi Cap Fund (Direct)" so plan types never get mixed up. */
export function withPlanType(name: string, planType: "DIRECT" | "REGULAR" | null | undefined): string {
  if (!planType || detectPlanType(name)) return name;
  return `${name} (${planType === "DIRECT" ? "Direct" : "Regular"})`;
}

export const normFolio = (f: string | null | undefined) => (f ?? "").replace(/[^0-9a-z]/gi, "").toLowerCase();

/** Best holding for a report line: same folio first, then fund name. */
export function matchHolding(
  fund: string,
  folio: string | null,
  holdings: PlanHolding[],
  taken: Set<PlanHolding> = new Set(),
): PlanHolding | null {
  const free = holdings.filter((h) => !taken.has(h));
  const f = normFolio(folio);
  const sameFolio = f ? free.filter((h) => normFolio(h.folio_number) === f || (normFolio(h.folio_number).startsWith(f) && f.length >= 6)) : [];
  const score = (h: PlanHolding) => nameSimilarity(fund, h.scheme_name);
  if (sameFolio.length === 1 && score(sameFolio[0]) >= 0.3) return sameFolio[0];
  const pool = sameFolio.length > 1 ? sameFolio : free;
  const ranked = pool.map((h) => ({ h, s: score(h) })).sort((a, b) => b.s - a.s);
  const top = ranked[0];
  if (!top) return null;
  const second = ranked[1]?.s ?? 0;
  const need = sameFolio.length > 1 ? 0.4 : 0.6;
  return top.s >= need && top.s - second >= 0.05 ? top.h : null;
}

export function buildPlanFromReport(report: AdvisoryReportParse, holdings: PlanHolding[]): ReportPlanDraft {
  const warnings = [...report.warnings];
  const items: PlanItemDraft[] = [];
  const taken = new Set<PlanHolding>();
  let priority = 10;

  for (const s of report.sells) {
    const h = matchHolding(s.fund, s.folio, holdings, taken);
    if (h) taken.add(h);
    else warnings.push(`Sell line "${s.fund}" (folio ${s.folio ?? "—"}) was not found in the CAS; please pick the security.`);
    if (s.action === "RETAIN") {
      if (h) {
        items.push({ action: "RETAIN", scheme_name: h.scheme_name, isin: h.isin, folio_number: h.folio_number, target_amount: 0, current_amount: h.current_value, reason: s.actionText, priority: priority += 10 });
      }
      continue;
    }
    if (s.action === "UNKNOWN") warnings.push(`Action "${s.actionText}" for ${s.fund} was read as SELL; please check.`);
    items.push({
      action: s.action === "SWITCH" ? "SWITCH" : "SELL",
      scheme_name: h?.scheme_name ?? s.fund,
      isin: h?.isin ?? null,
      folio_number: h?.folio_number ?? s.folio,
      target_amount: s.value,
      current_amount: h?.current_value ?? null,
      reason: s.actionText || null,
      priority: (priority += 10),
    });
  }

  for (const h of holdings) {
    if (taken.has(h)) continue;
    items.push({ action: "RETAIN", scheme_name: h.scheme_name, isin: h.isin, folio_number: h.folio_number, target_amount: 0, current_amount: h.current_value, reason: "Not sold in the report", priority: (priority += 10) });
  }

  for (const b of report.buys) {
    items.push({
      action: "BUY",
      scheme_name: withPlanType(b.fund, b.planType),
      isin: null,
      folio_number: null,
      target_amount: b.amount,
      current_amount: null,
      reason: [b.category, b.mode ? `Mode: ${b.mode}` : null, b.fundedBy ? `Funded by: ${b.fundedBy}` : null].filter(Boolean).join(" · ") || null,
      priority: (priority += 10),
      amc: b.amc,
      plan_type: b.planType ?? detectPlanType(b.fund),
    });
  }

  const sip_items: SipItemDraft[] = [];
  for (const s of report.sips) {
    const planType = s.planType ?? detectPlanType(s.fund);
    // Existing SIPs (STOP / CHANGE) run in held funds: take the ISIN from the CAS.
    const h = s.change === "START" ? null : matchHolding(s.fund, null, holdings);
    if (s.change === "STOP" && !(s.current && s.current > 0)) {
      warnings.push(`SIP stop for ${s.fund} has no current amount; skipped.`);
      continue;
    }
    if (s.change === "START" && !(s.next && s.next > 0)) {
      warnings.push(`SIP start for ${s.fund} has no amount; skipped.`);
      continue;
    }
    sip_items.push({
      action: s.change,
      scheme_name: h?.scheme_name ?? withPlanType(s.fund, planType),
      isin: h?.isin ?? null,
      folio_number: h?.folio_number ?? null,
      old_amount: s.change === "START" ? null : s.current,
      new_amount: s.change === "STOP" ? null : s.next,
      frequency: "MONTHLY",
      notes: [s.changeText, s.frequencyNote].filter(Boolean).join(" · ") || null,
      plan_type: planType,
    });
  }

  const notes = [
    `Imported from the advisory report${report.preparedDate ? ` prepared ${report.preparedDate}` : ""}.`,
    report.riskProfile ? `Risk profile: ${report.riskProfile}.` : null,
    report.goal ? `Goal: ${report.goal}.` : null,
    ...report.deploymentNotes.map((n) => `• ${n}`),
  ].filter(Boolean).join("\n");

  return {
    plan_name: `Rebalancing plan${report.preparedDate ? ` · ${report.preparedDate}` : ""}`,
    plan_date: report.preparedDate,
    starting_portfolio_value: report.currentValue,
    items,
    sip_items,
    declared_totals: { exit_value: report.sellTotal, buy_value: report.buyTotal },
    notes,
    warnings,
  };
}
