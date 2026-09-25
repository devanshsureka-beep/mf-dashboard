/**
 * Advisory report + CAS holdings -> plan items (pure, unit-tested).
 *
 * - Each SELL/SWITCH row in the report is tied to the CAS holding with the same
 *   folio (and closest fund name), so the plan item carries the ISIN.
 * - Holdings the report does not sell are RETAIN items (tracked, no target).
 * - BUY rows become BUY items; SIP rows become START / STOP / CHANGE items.
 * Every line must tie to the CAS without doubt (folio, fund, plan type and
 * value); anything that does not is a blocking problem. Nothing is guessed.
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
  /** Anything that does not tie out. The plan must not be created while any remain. */
  problems: string[];
  /** @deprecated alias of `problems` */
  warnings: string[];
}

/** "HDFC Flexi Cap Fund" + DIRECT -> "HDFC Flexi Cap Fund (Direct)" so plan types never get mixed up. */
export function withPlanType(name: string, planType: "DIRECT" | "REGULAR" | null | undefined): string {
  if (!planType || detectPlanType(name)) return name;
  return `${name} (${planType === "DIRECT" ? "Direct" : "Regular"})`;
}

export const normFolio = (f: string | null | undefined) => (f ?? "").replace(/[^0-9a-z]/gi, "").toLowerCase();

const holdingPlan = (h: PlanHolding) => h.plan_type ?? detectPlanType(h.scheme_name);
const samePlan = (planType: "DIRECT" | "REGULAR" | null | undefined, h: PlanHolding) => {
  const hp = holdingPlan(h);
  return !planType || !hp || hp === planType;
};

/** Best holding for a report line: same folio first, then fund name. Never crosses Direct/Regular. */
export function matchHolding(
  fund: string,
  folio: string | null,
  holdings: PlanHolding[],
  taken: Set<PlanHolding> = new Set(),
  planType: "DIRECT" | "REGULAR" | null = detectPlanType(fund),
): PlanHolding | null {
  const free = holdings.filter((h) => !taken.has(h) && samePlan(planType, h));
  const f = normFolio(folio);
  const sameFolio = f ? free.filter((h) => normFolio(h.folio_number) === f || (normFolio(h.folio_number).startsWith(f) && f.length >= 6)) : [];
  const score = (h: PlanHolding) => nameSimilarity(fund, h.scheme_name);
  if (sameFolio.length === 1 && score(sameFolio[0]) >= 0.3) return sameFolio[0];
  const pool = sameFolio.length > 1 ? sameFolio : free;
  const ranked = pool.map((h) => ({ h, s: score(h) })).sort((a, b) => b.s - a.s);
  const top = ranked[0];
  if (!top) return null;
  const second = ranked[1]?.s ?? 0;
  const need = sameFolio.length > 1 ? 0.4 : 0.7;
  // Same fund in two folios (identical names): ambiguous by name, so not matched here.
  return top.s >= need && top.s - second >= 0.05 ? top.h : null;
}

/**
 * The fund (security) a line refers to, when the folio does not matter (SIPs,
 * top-ups). Several folios of the SAME fund are fine: the folio is left blank.
 */
function matchFund(fund: string, holdings: PlanHolding[], planType: "DIRECT" | "REGULAR" | null): PlanHolding | null {
  const one = matchHolding(fund, null, holdings, new Set(), planType);
  if (one) return one;
  const ranked = holdings
    .filter((h) => samePlan(planType, h))
    .map((h) => ({ h, s: nameSimilarity(fund, h.scheme_name) }))
    .sort((a, b) => b.s - a.s);
  if (!ranked.length || ranked[0].s < 0.7) return null;
  const tied = ranked.filter((r) => r.s >= ranked[0].s - 0.001);
  const key = (h: PlanHolding) => h.isin ?? h.scheme_name.toLowerCase();
  const sameFund = tied.every((r) => key(r.h) === key(tied[0].h));
  const next = ranked.find((r) => key(r.h) !== key(tied[0].h));
  if (!sameFund || (next && ranked[0].s - next.s < 0.05)) return null;
  return { ...tied[0].h, folio_number: null };
}

/** Every folio of the one fund a name refers to (same fund = same ISIN / name). */
function sameFundHoldings(fund: string, holdings: PlanHolding[], planType: "DIRECT" | "REGULAR" | null): PlanHolding[] {
  const ranked = holdings
    .filter((h) => samePlan(planType, h))
    .map((h) => ({ h, s: nameSimilarity(fund, h.scheme_name) }))
    .filter((r) => r.s >= 0.7)
    .sort((a, b) => b.s - a.s);
  if (!ranked.length) return [];
  const key = (h: PlanHolding) => h.isin ?? h.scheme_name.toLowerCase();
  const topKey = key(ranked[0].h);
  const next = ranked.find((r) => key(r.h) !== topKey);
  if (next && ranked[0].s - next.s < 0.05) return []; // two different funds look alike: not decided by name
  return ranked.filter((r) => key(r.h) === topKey).map((r) => r.h);
}

const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
/** Report values are rounded to the rupee; CAS values carry paise. */
const sameValue = (a: number, b: number) => Math.abs(a - b) <= Math.max(2, Math.abs(b) * 0.002);

/**
 * Turn the report into plan items, tied to the CAS holdings. Every line must
 * tie to the CAS without doubt; anything that does not is returned in
 * `problems`, and callers must not create the plan while any remain.
 */
export function buildPlanFromReport(
  report: AdvisoryReportParse,
  holdings: PlanHolding[],
  casValuationDate: string | null = null,
): ReportPlanDraft {
  const problems = [...report.problems];
  const items: PlanItemDraft[] = [];
  const taken = new Set<PlanHolding>();
  let priority = 10;
  const live = holdings.filter((h) => h.current_value > 0);

  // The report must be built on this very CAS, or its amounts do not apply.
  const sameStatement = !report.valuationDate || !casValuationDate || report.valuationDate === casValuationDate;
  if (!sameStatement) {
    problems.push(`The report was made from a CAS valued on ${report.valuationDate}, but the uploaded CAS is valued on ${casValuationDate}. Upload the same CAS the report was made from.`);
  }

  // Report fund name -> CAS holdings it was tied to (a report may call a fund by
  // another name than the CAS, e.g. "Aggressive Hybrid" for "Equity & Debt").
  const alias: { fund: string; holdings: PlanHolding[] }[] = [];
  const viaAlias = (fund: string, planType: "DIRECT" | "REGULAR" | null): PlanHolding[] => {
    const a = alias.find((x) => nameSimilarity(x.fund, fund) >= 0.9 && x.holdings.every((h) => samePlan(planType, h)));
    return a ? a.holdings : [];
  };

  // ---- Sells: each tied to one holding (folio + name), values checked. ----
  for (const s of report.sells) {
    const planType = detectPlanType(s.fund);
    if ((s.folioCount ?? 1) > 1) {
      // One row for several folios of the same fund ("x2 folios"): all of them, values summed.
      const group = sameFundHoldings(s.fund, live.filter((x) => !taken.has(x)), planType);
      const total = group.reduce((t, x) => t + x.current_value, 0);
      if (group.length !== s.folioCount) {
        problems.push(`Sell row "${s.fund}" covers ${s.folioCount} folios, but the CAS has ${group.length} matching folio(s).`);
        continue;
      }
      if (sameStatement && !s.partial && !sameValue(s.value, total)) {
        problems.push(`${group[0].scheme_name}: the report sells ${inr(s.value)} across ${group.length} folios, but the CAS holds ${inr(total)}.`);
      }
      alias.push({ fund: s.fund, holdings: group });
      for (const g of group) {
        taken.add(g);
        items.push({ action: s.action === "SWITCH" ? "SWITCH" : "SELL", scheme_name: g.scheme_name, isin: g.isin, folio_number: g.folio_number, target_amount: s.partial ? Math.round((s.value * g.current_value / total) * 100) / 100 : g.current_value, current_amount: g.current_value, reason: `${s.actionText} (${group.length} folios)`, priority: (priority += 10) });
      }
      continue;
    }
    // A full exit sells the whole holding: a unique holding of this plan type whose
    // CAS value equals the report amount (and whose name agrees) is the strongest match.
    const byValue = !s.partial && sameStatement
      ? live.filter((x) => !taken.has(x) && samePlan(planType, x) && sameValue(s.value, x.current_value) && nameSimilarity(s.fund, x.scheme_name) >= 0.4
          && (!s.folio || normFolio(x.folio_number).startsWith(normFolio(s.folio)) || normFolio(s.folio).startsWith(normFolio(x.folio_number))))
      : [];
    let h = byValue.length === 1 ? byValue[0] : matchHolding(s.fund, s.folio, live, taken, planType);
    if (!h) {
      // Same fund in more than one folio: the folio decides.
      const byFolio = live.filter((x) => !taken.has(x) && normFolio(x.folio_number) === normFolio(s.folio) && samePlan(planType, x));
      h = byFolio.length === 1 ? byFolio[0] : null;
    }
    if (!h) {
      problems.push(`Sell row "${s.fund}" (folio ${s.folio ?? "—"}) does not match any fund in the CAS.`);
      continue;
    }
    taken.add(h);
    alias.push({ fund: s.fund, holdings: [h] });
    if (sameStatement) {
      if (!s.partial && !sameValue(s.value, h.current_value)) {
        problems.push(`${h.scheme_name}: the report sells ${inr(s.value)} as a full exit, but the CAS holding is ${inr(h.current_value)}.`);
      }
      if (s.partial && s.value >= h.current_value) {
        problems.push(`${h.scheme_name}: the report trims ${inr(s.value)}, but the CAS holding is only ${inr(h.current_value)}.`);
      }
    }
    items.push({
      action: s.action === "SWITCH" ? "SWITCH" : "SELL",
      scheme_name: h.scheme_name,
      isin: h.isin,
      folio_number: h.folio_number,
      target_amount: s.value,
      current_amount: h.current_value,
      reason: s.actionText || null,
      priority: (priority += 10),
    });
  }

  // ---- Fund-wise review ↔ CAS: every holding has exactly one verdict. ----
  if (report.review.length) {
    const reviewed = new Set<PlanHolding>();
    for (const r of report.review) {
      const cands = live
        .filter((h) => !reviewed.has(h) && nameSimilarity(r.fund, h.scheme_name) >= 0.6)
        .sort((a, b) => Math.abs(a.current_value - r.value) - Math.abs(b.current_value - r.value));
      const h = cands[0];
      if (!h) {
        problems.push(`The report reviews ${r.fund} (${inr(r.value)}), but that fund is not in the CAS.`);
        continue;
      }
      reviewed.add(h);
      if (sameStatement && !sameValue(r.value, h.current_value)) {
        problems.push(`${h.scheme_name}: the report values it at ${inr(r.value)}, the CAS at ${inr(h.current_value)}.`);
      }
      if (r.verdict === "HOLD" && taken.has(h)) problems.push(`${h.scheme_name}: the review says HOLD but it is in the sell list.`);
    }
    for (const h of live) {
      if (!reviewed.has(h)) problems.push(`${h.scheme_name} (folio ${h.folio_number ?? "—"}, ${inr(h.current_value)}) is in the CAS but not covered by the report.`);
    }
  }

  // ---- Other layouts: held/deferred funds (with values) and fund lists prove coverage. ----
  const holdReason = new Map<PlanHolding, string>();
  if (!report.review.length) {
    const covered = new Set<PlanHolding>(taken);
    const pick = (fund: string, folio: string | null, count: number, planType: "DIRECT" | "REGULAR" | null): PlanHolding[] => {
      const known = viaAlias(fund, planType);
      if (known.length && (!folio || known.some((k) => normFolio(k.folio_number).startsWith(normFolio(folio))))) return known;
      if (folio) {
        const byFolio = live.filter((x) => normFolio(x.folio_number) === normFolio(folio) || (normFolio(x.folio_number).startsWith(normFolio(folio)) && normFolio(folio).length >= 6));
        const named = byFolio.filter((x) => samePlan(planType, x) && nameSimilarity(fund, x.scheme_name) >= 0.4);
        if (named.length === 1) return named;
      }
      const group = sameFundHoldings(fund, live, planType);
      return count > 1 || group.length === 1 ? group : group.filter((x) => !covered.has(x)).slice(0, 1);
    };
    for (const hd of report.holds) {
      const byValue = hd.folioCount === 1 && sameStatement
        ? live.filter((x) => !covered.has(x) && samePlan(hd.planType, x) && sameValue(hd.value, x.current_value) && nameSimilarity(hd.fund, x.scheme_name) >= 0.4)
        : [];
      const group = byValue.length === 1 ? byValue : pick(hd.fund, hd.folio, hd.folioCount, hd.planType);
      if (!group.length) {
        problems.push(`The report keeps "${hd.fund}"${hd.folio ? ` (folio ${hd.folio})` : ""} (${inr(hd.value)}), but that fund is not in the CAS.`);
        continue;
      }
      const total = group.reduce((t, x) => t + x.current_value, 0);
      if (sameStatement && !sameValue(hd.value, total)) problems.push(`${group[0].scheme_name}: the report values it at ${inr(hd.value)}, the CAS at ${inr(total)}.`);
      for (const g of group) {
        if (taken.has(g)) problems.push(`${g.scheme_name}: the report both sells it and keeps it.`);
        covered.add(g);
        holdReason.set(g, `Kept for now: ${hd.note || "held / deferred in the report"}`.slice(0, 300));
      }
    }
    for (const m of report.mentioned) for (const g of pick(m.fund, m.folio, m.folioCount, m.planType)) covered.add(g);
    for (const x of [...report.sips.filter((z) => z.change !== "START").map((z) => ({ fund: z.fund, planType: z.planType })), ...report.buys.filter((b) => b.kind === "TOP_UP").map((b) => ({ fund: b.fund, planType: b.planType }))]) {
      const pt = x.planType ?? detectPlanType(x.fund);
      for (const g of [...viaAlias(x.fund, pt), ...sameFundHoldings(x.fund, live, pt)]) covered.add(g);
    }
    for (const h of live) {
      if (!covered.has(h)) problems.push(`${h.scheme_name} (folio ${h.folio_number ?? "—"}, ${inr(h.current_value)}) is in the CAS but not covered by the report.`);
    }
  }

  for (const h of live) {
    if (taken.has(h)) continue;
    items.push({ action: "RETAIN", scheme_name: h.scheme_name, isin: h.isin, folio_number: h.folio_number, target_amount: 0, current_amount: h.current_value, reason: holdReason.get(h) ?? "Not sold in the report", priority: (priority += 10) });
  }

  // ---- Buys: new funds by name; a top-up must be a fund already held. ----
  for (const b of report.buys) {
    const planType = b.planType ?? detectPlanType(b.fund);
    const held = matchFund(b.fund, live, planType);
    if (b.kind === "TOP_UP" && !held) problems.push(`Buy row "${b.fund}" is marked top-up, but no ${planType ?? ""} holding of it is in the CAS.`.replace("  ", " "));
    items.push({
      action: "BUY",
      scheme_name: held?.scheme_name ?? withPlanType(b.fund, planType),
      isin: held?.isin ?? null,
      folio_number: held?.folio_number ?? null,
      target_amount: b.amount,
      current_amount: held?.current_value ?? null,
      reason: [b.category, b.mode ? `Mode: ${b.mode}` : null, b.fundedBy ? `Funded by: ${b.fundedBy}` : null].filter(Boolean).join(" · ") || null,
      priority: (priority += 10),
      amc: b.amc,
      plan_type: planType,
    });
  }

  // ---- SIPs: stops/changes run in held funds (must tie to the CAS). ----
  const sip_items: SipItemDraft[] = [];
  const buyItems = items.filter((i) => i.action === "BUY");
  for (const s of report.sips) {
    // A new SIP usually goes into a fund bought in the same report: use that
    // exact fund (same plan type, same security) rather than a look-alike.
    const buy = s.change === "START"
      ? buyItems.find((b) => nameSimilarity(s.fund, b.scheme_name) >= 0.85 && (!s.planType || !b.plan_type || b.plan_type === s.planType))
      : undefined;
    const planType = s.planType ?? detectPlanType(s.fund) ?? buy?.plan_type ?? null;
    const known = viaAlias(s.fund, planType);
    const h = matchFund(s.fund, live, planType) ?? (known.length ? { ...known[0], folio_number: known.length === 1 ? known[0].folio_number : null } : null);
    if (s.change !== "START" && !h) {
      problems.push(`SIP ${s.change === "STOP" ? "stop" : "change"} for "${s.fund}" does not match any fund in the CAS.`);
      continue;
    }
    if (s.change === "START" && !planType) {
      problems.push(`New SIP in "${s.fund}": the report does not say Direct or Regular, and the fund is not in the buy list.`);
      continue;
    }
    sip_items.push({
      action: s.change,
      scheme_name: h?.scheme_name ?? buy?.scheme_name ?? withPlanType(s.fund, planType),
      isin: h?.isin ?? null,
      folio_number: h?.folio_number ?? null,
      old_amount: s.change === "START" ? null : s.current,
      new_amount: s.change === "STOP" ? null : s.next,
      frequency: "MONTHLY",
      notes: [
        s.changeText,
        s.frequencyNote,
        s.excludedFromTotal ? "Report footnote: not in the current SIP total (may already have ended)" : null,
      ].filter(Boolean).join(" · ") || null,
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
    problems,
    warnings: problems,
  };
}
