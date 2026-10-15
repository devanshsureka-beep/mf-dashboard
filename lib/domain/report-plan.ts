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
  /**
   * As read from the report. MIGRATE: Regular -> Direct plan of the same fund. The plan
   * itself stores Buy, Sell or Keep only (asBuySellKeep, services/plans.ts ingest).
   */
  action: "SELL" | "SWITCH" | "BUY" | "RETAIN" | "MIGRATE";
  /** MIGRATE: the Direct plan to move to. */
  switch_to_scheme_name?: string | null;
  scheme_name: string;
  isin: string | null;
  folio_number: string | null;
  target_amount: number;
  current_amount: number | null;
  reason: string | null;
  priority: number;
  /** The report's wording could not be read as Buy, Sell or Keep: asked on the plan (the line is a Keep until answered). */
  question?: string | null;
  /** Report vs a newer CAS: what differs and what the CAS shows done since the report (prefills the answer). */
  diff?: ReportDiff | null;
  /** For BUY rows: details used to create a name-only security if needed. */
  amc?: string | null;
  plan_type?: "DIRECT" | "REGULAR" | null;
}

/** A difference between the report and a CAS taken after it, with the trades since the report. */
export interface ReportDiff {
  kind: "SELL_GONE" | "SELL_CHANGED" | "KEEP_GONE" | "KEEP_CHANGED" | "BUY_HELD" | "NOT_IN_REPORT" | "TRADED";
  /** What the report says for the fund (rupees), and what the new CAS holds. */
  report_amount: number | null;
  cas_value: number;
  sold_since: number;
  bought_since: number;
  /** Suggested answer: the line becomes this, with `done_amount` already done on `done_date`. */
  suggest: "SELL" | "BUY" | "RETAIN";
  done_amount: number;
  done_date: string | null;
}

/** A trade from the newer CAS (only those after the report's date count as done since the report). */
export interface SinceTrade {
  scheme_name: string;
  isin: string | null;
  date: string;
  type: string;
  amount: number;
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
  plan_kind: "FULL" | "ADDITIONAL";
  /** ADDITIONAL plans: fresh money the client brings in. */
  fresh_money: number | null;
  plan_date: string | null;
  starting_portfolio_value: number | null;
  items: PlanItemDraft[];
  sip_items: SipItemDraft[];
  declared_totals: { exit_value: number | null; buy_value: number | null };
  notes: string;
  /** Anything that does not tie out. The plan must not be created while any remain. */
  problems: string[];
  /** Differences explained by NAV movement between the report's CAS and the uploaded one (not blocking). */
  drift: string[];
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
 * When the report was made from an earlier (or undated) CAS, NAVs have moved in
 * between: values may differ by market movement, never by more than this.
 */
export const NAV_DRIFT_LIMIT = 0.15;

/**
 * A CAS older than the report's own CAS by more than this cannot back the report:
 * the client bought / sold in between, so the values are not NAV movement.
 */
export const CAS_OLDER_THAN_REPORT_DAYS = 7;
const STALE_CAS = "Upload the client's CAS of";
export const isStaleCasProblem = (p: string) => p.includes(STALE_CAS);

/** CAS funds the report never mentions are kept (flagged) only up to this share of the portfolio. */
export const NOT_IN_REPORT_LIMIT = 0.25;

/**
 * Turn the report into plan items, tied to the CAS holdings. Every line must
 * tie to the CAS without doubt; anything that does not is returned in
 * `problems`, and callers must not create the plan while any remain.
 */
export function buildPlanFromReport(
  report: AdvisoryReportParse,
  holdings: PlanHolding[],
  casValuationDate: string | null = null,
  opts: {
    additional?: boolean;
    /**
     * The CAS is newer than the report: differences are not blocking problems but
     * questions for the desk, prefilled with the trades the CAS shows since the report.
     */
    since?: { trades: SinceTrade[] };
  } = {},
): ReportPlanDraft {
  // ADDITIONAL: a report for fresh money on top of the active plan. Only its own
  // lines must tie to the CAS; the rest of the portfolio stays as the active plan has it.
  const additional = opts.additional === true;
  const problems = [...report.problems];
  const items: PlanItemDraft[] = [];
  const taken = new Set<PlanHolding>();
  let priority = 10;
  const live = holdings.filter((h) => h.current_value > 0);
  // Report vs a newer CAS: lines that differ are marked, asked about at the end (see `since`).
  const tolerant = Boolean(opts.since);
  const differs = new Map<PlanItemDraft, { kind: ReportDiff["kind"]; report: number | null }>();
  const flagged = new Map<PlanHolding, { kind: ReportDiff["kind"]; report: number | null }>();
  /** A fund the report names that the newer CAS no longer holds (a zero balance keeps its ISIN). */
  const goneHolding = (fund: string, planType: "DIRECT" | "REGULAR" | null): PlanHolding | null => {
    const zero = holdings.find((h) => h.current_value <= 0 && samePlan(planType, h) && nameSimilarity(fund, h.scheme_name) >= 0.7);
    if (zero) return zero;
    // A fully redeemed fund is no longer a holding, but its trades are in the CAS (with its ISIN).
    const t = (opts.since?.trades ?? [])
      .map((x) => ({ x, s: nameSimilarity(fund, x.scheme_name) }))
      .filter((r) => r.s >= 0.7 && samePlan(planType, { scheme_name: r.x.scheme_name, isin: r.x.isin, folio_number: null, current_value: 0 }))
      .sort((a, b) => b.s - a.s)[0]?.x;
    return t ? { scheme_name: t.scheme_name, isin: t.isin, folio_number: null, current_value: 0 } : null;
  };
  /** A fund the report keeps that the newer CAS no longer holds: a Keep line, asked about. */
  const keepGone = (fund: string, planType: "DIRECT" | "REGULAR" | null, value: number | null, note: string | null | undefined) => {
    const gone = goneHolding(fund, planType);
    const it: PlanItemDraft = { action: "RETAIN", scheme_name: gone?.scheme_name ?? fund, isin: gone?.isin ?? null, folio_number: gone?.folio_number ?? null,
      target_amount: 0, current_amount: 0, reason: `Report: ${note || "keep"}`.slice(0, 300), priority: (priority += 10), plan_type: planType };
    items.push(it);
    differs.set(it, { kind: "KEEP_GONE", report: value });
  };
  /** The report buys this fund (so a newer CAS may already hold it). */
  const boughtInReport = (h: PlanHolding) => report.buys.some((b) => nameSimilarity(b.fund, h.scheme_name) >= 0.7 && samePlan(b.planType ?? detectPlanType(b.fund), h));

  // Same statement (both dated, same day): values must agree to ±0.2%. Otherwise
  // (a later CAS, or a report without a date) NAVs moved in between: differences
  // up to NAV_DRIFT_LIMIT are market movement and are listed, not blocked.
  const reportDate = report.valuationDate ?? report.casPeriod?.to ?? null;
  const daysApart = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
  // A statement "to 11-Aug" values holdings at the last NAV (e.g. 10-Aug): same statement.
  // No CAS date to compare (never the case for a real CAS): stay strict.
  const sameStatement = !casValuationDate || Boolean(reportDate && (reportDate === casValuationDate ||
    (!report.valuationDate && daysApart(reportDate, casValuationDate) <= 3)));
  // (A date equal to the report's preparation date is not evidence of which CAS it used.)
  const casTooOld = Boolean(reportDate && casValuationDate && reportDate !== report.preparedDate &&
    Date.parse(reportDate) - Date.parse(casValuationDate) > CAS_OLDER_THAN_REPORT_DAYS * 86_400_000);
  const staleCas = casTooOld
    ? `The uploaded CAS is of ${casValuationDate}, but the report was made from a CAS of ${reportDate} (${Math.round(daysApart(reportDate!, casValuationDate!))} days later), so the holdings have changed in between. ${STALE_CAS} ${reportDate} or later.`
    : null;
  const drift: string[] = [];
  if (!sameStatement) {
    drift.push(reportDate && casValuationDate
      ? `The report was made from a CAS of ${reportDate}; the uploaded CAS is of ${casValuationDate}. Values differ by NAV movement; full exits sell every unit at today's value.`
      : `The report does not say which CAS date it used; values are compared allowing for NAV movement.`);
  }
  /** Do a report value and a CAS value agree? Records NAV-movement differences; false = real mismatch. */
  const valueOk = (reportValue: number, casValue: number, label: string): boolean => {
    if (sameValue(reportValue, casValue)) return true;
    if (sameStatement) return false;
    const gap = Math.abs(reportValue - casValue) / Math.max(1, Math.abs(casValue));
    if (gap > NAV_DRIFT_LIMIT) return false;
    drift.push(`${label}: report ${inr(reportValue)}, CAS ${inr(Math.round(casValue * 100) / 100)} (${casValue >= reportValue ? "+" : "−"}${(gap * 100).toFixed(1)}%).`);
    return true;
  };

  // Report fund name -> CAS holdings it was tied to (a report may call a fund by
  // another name than the CAS, e.g. "Aggressive Hybrid" for "Equity & Debt").
  const alias: { fund: string; holdings: PlanHolding[] }[] = [];
  const viaAlias = (fund: string, planType: "DIRECT" | "REGULAR" | null): PlanHolding[] => {
    const a = alias.find((x) => nameSimilarity(x.fund, fund) >= 0.9 && x.holdings.every((h) => samePlan(planType, h)));
    return a ? a.holdings : [];
  };

  // ---- Sells: each tied to one holding (folio + name), values checked. ----
  for (const s of report.sells) {
    const before = items.length;
    try {
      const planType = detectPlanType(s.fund);
      // A row without a folio for a fund held in several folios (reports that list funds, not folios):
      // a full exit sells every folio of that fund.
      const allFolios = !s.folio && (s.folioCount ?? 1) === 1 && !s.partial
        ? sameFundHoldings(s.fund, live.filter((x) => !taken.has(x)), planType)
        : [];
      const wholeFund = allFolios.length > 1 && !allFolios.some((x) => sameValue(s.value, x.current_value));
      if ((s.folioCount ?? 1) > 1 || wholeFund) {
        // One row for several folios of the same fund ("x2 folios"): all of them, values summed.
        const group = wholeFund ? allFolios : sameFundHoldings(s.fund, live.filter((x) => !taken.has(x)), planType);
        const total = group.reduce((t, x) => t + x.current_value, 0);
        // "Trim 33%": that share of the CAS holding (computed here, the report itself is not changed).
        const sold = s.partial && !s.value && s.percent ? Math.round(total * s.percent) / 100 : s.value;
        if (!wholeFund && group.length !== s.folioCount) {
          if (tolerant) {
            // Report vs a newer CAS: some or all of the folios are already sold. Folios still held stay
            // a sell; the rest is one line for the fund, asked about.
            for (const g of group) {
              taken.add(g);
              const it: PlanItemDraft = { action: s.action === "SWITCH" ? "SWITCH" : "SELL", scheme_name: g.scheme_name, isin: g.isin, folio_number: g.folio_number,
                target_amount: g.current_value, current_amount: g.current_value, reason: `${s.actionText} (${s.folioCount} folios in the report)`, priority: (priority += 10) };
              items.push(it);
              differs.set(it, { kind: "SELL_CHANGED", report: null });
            }
            if (!group.length) {
              const gone = goneHolding(s.fund, planType);
              const it: PlanItemDraft = { action: s.action === "SWITCH" ? "SWITCH" : "SELL", scheme_name: gone?.scheme_name ?? s.fund, isin: gone?.isin ?? null, folio_number: null,
                target_amount: s.value, current_amount: 0, reason: `${s.actionText} (${s.folioCount} folios)`, priority: (priority += 10), plan_type: planType };
              items.push(it);
              differs.set(it, { kind: "SELL_GONE", report: s.value });
            }
            continue;
          }
          problems.push(`Sell row "${s.fund}" covers ${s.folioCount} folios, but the CAS has ${group.length} matching folio(s).`);
          continue;
        }
        if (!s.partial && !valueOk(s.value, total, group[0].scheme_name)) {
          problems.push(`${group[0].scheme_name}: the report sells ${inr(s.value)} across ${group.length} folios, but the CAS holds ${inr(total)}.`);
        }
        alias.push({ fund: s.fund, holdings: group });
        for (const g of group) {
          taken.add(g);
          items.push({ action: s.action === "SWITCH" ? "SWITCH" : "SELL", scheme_name: g.scheme_name, isin: g.isin, folio_number: g.folio_number, target_amount: s.partial ? Math.round((sold * g.current_value / total) * 100) / 100 : g.current_value, current_amount: g.current_value, reason: `${s.actionText} (${group.length} folios)`, priority: (priority += 10) });
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
      // Report vs a newer CAS: a fund now fully sold may look like another fund still held (same AMC);
      // the closer name wins.
      if (h && tolerant) {
        const gone = goneHolding(s.fund, planType);
        if (gone && nameSimilarity(s.fund, gone.scheme_name) > nameSimilarity(s.fund, h.scheme_name)) h = null;
        // The report names the folio: another folio of the same fund is not this one (it may be kept).
        else if (s.folio && h.folio_number && !normFolio(h.folio_number).startsWith(normFolio(s.folio)) && !normFolio(s.folio).startsWith(normFolio(h.folio_number))) h = null;
      }
      if (!h) {
        if (tolerant) {
          // Already sold, or the fund changed: asked.
          const gone = goneHolding(s.fund, planType);
          const it: PlanItemDraft = { action: s.action === "SWITCH" ? "SWITCH" : "SELL", scheme_name: gone?.scheme_name ?? s.fund, isin: gone?.isin ?? null,
            folio_number: gone?.folio_number ?? s.folio, target_amount: s.value, current_amount: 0, reason: s.actionText || null, priority: (priority += 10), plan_type: planType };
          items.push(it);
          differs.set(it, { kind: "SELL_GONE", report: s.value });
          continue;
        }
        problems.push(`Sell row "${s.fund}" (folio ${s.folio ?? "—"}) does not match any fund in the CAS.`);
        continue;
      }
      taken.add(h);
      alias.push({ fund: s.fund, holdings: [h] });
      // "Trim 33%": that share of the CAS holding (computed here, the report itself is not changed).
      const sold = s.partial && !s.value && s.percent ? Math.round(h.current_value * s.percent) / 100 : s.value;
      const exitDiffers = !s.partial && !valueOk(s.value, h.current_value, h.scheme_name);
      const trimDiffers = s.partial && sold >= h.current_value;
      if (exitDiffers && !tolerant) {
        problems.push(`${h.scheme_name}: the report sells ${inr(s.value)} as a full exit, but the CAS holding is ${inr(h.current_value)}${sameStatement ? "" : ` (more than ${NAV_DRIFT_LIMIT * 100}% apart, too much for NAV movement)`}.`);
      }
      if (trimDiffers && !tolerant) {
        problems.push(`${h.scheme_name}: the report trims ${inr(sold)}, but the CAS holding is only ${inr(h.current_value)}.`);
      }
      if (tolerant && (exitDiffers || trimDiffers)) {
        // Partly done since the report (or the holding changed): the report's amount stays the target.
        const it: PlanItemDraft = { action: s.action === "SWITCH" ? "SWITCH" : "SELL", scheme_name: h.scheme_name, isin: h.isin, folio_number: h.folio_number,
          target_amount: s.partial ? sold : Math.max(s.value, h.current_value), current_amount: h.current_value, reason: s.actionText || null, priority: (priority += 10) };
        items.push(it);
        differs.set(it, { kind: "SELL_CHANGED", report: s.partial ? sold : s.value });
        continue;
      }
      items.push({
        action: s.action === "SWITCH" ? "SWITCH" : "SELL",
        scheme_name: h.scheme_name,
        isin: h.isin,
        folio_number: h.folio_number,
        // A full exit sells every unit: its value is the CAS holding, whatever the NAV did since the report.
        target_amount: s.partial ? sold : h.current_value,
        current_amount: h.current_value,
        reason: s.actionText || null,
        priority: (priority += 10),
      });
    } finally {
      // A sell read only from the review ("Full exit" with no sell-table row): a person confirms it.
      if (s.fromReview) {
        for (const it of items.slice(before)) {
          it.question ??= `The report's review says "${s.actionText}" for this fund, but its sell table leaves it out. Sell it (amount prefilled), or keep it?`;
        }
      }
    }
  }

  // ---- Fund-wise review ↔ CAS: every holding has exactly one verdict. ----
  // A review row covers every folio of one fund + plan ("Direct · 3 folios"); the CAS lists folios separately.
  const holdReason = new Map<PlanHolding, string>();
  const unreported: string[] = [];
  // Holdings the report moves from Regular to the Direct plan of the same fund -> Direct fund name.
  const migrateTo = new Map<PlanHolding, string>();
  // Holdings whose recommendation the desk must explain (see report.questions).
  const asked = new Map<PlanHolding, NonNullable<AdvisoryReportParse["questions"]>[number]>();
  const isMigrate = (note: string | null | undefined) => /MIGRATE TO DIRECT/i.test(note ?? "");
  const directName = directPlanName;
  if (report.review.length) {
    const reviewed = new Set<PlanHolding>();
    const fundKey = (h: PlanHolding) => h.isin ?? h.scheme_name.toLowerCase();
    for (const r of report.review) {
      const cands = live.filter((h) =>
        !reviewed.has(h) && nameSimilarity(r.fund, h.scheme_name) >= 0.6 &&
        (!r.planType || !holdingPlan(h) || holdingPlan(h) === r.planType));
      const groups = new Map<string, PlanHolding[]>();
      for (const h of cands) groups.set(fundKey(h), [...(groups.get(fundKey(h)) ?? []), h]);
      const total = (g: PlanHolding[]) => g.reduce((t, h) => t + h.current_value, 0);
      // Options: all folios of a fund together, or one folio alone (reports that review folio by folio).
      const options = [...groups.values(), ...cands.filter((h) => (groups.get(fundKey(h))?.length ?? 0) > 1).map((h) => [h])];
      const group = options.sort((a, b) =>
        Math.abs(total(a) - r.value) - Math.abs(total(b) - r.value) ||
        (r.folioCount ? Number(b.length === r.folioCount) - Number(a.length === r.folioCount) : 0) ||
        nameSimilarity(r.fund, b[0].scheme_name) - nameSimilarity(r.fund, a[0].scheme_name))[0];
      if (!group) {
        if (tolerant) {
          if (r.verdict !== "EXIT" && r.verdict !== "SWITCH" && r.verdict !== "TRIM") keepGone(r.fund, r.planType ?? null, r.value, r.verdictText);
          continue;
        }
        problems.push(`The report reviews ${r.fund} (${inr(r.value)}), but that fund is not in the CAS.`);
        continue;
      }
      group.forEach((h) => reviewed.add(h));
      if (!valueOk(r.value, total(group), group[0].scheme_name)) {
        if (tolerant) {
          for (const h of group) if (!taken.has(h)) flagged.set(h, { kind: "KEEP_CHANGED", report: r.value });
        } else problems.push(`${group[0].scheme_name}: the report values it at ${inr(r.value)}, the CAS at ${inr(Math.round(total(group) * 100) / 100)}.`);
      }
      if (r.verdict === "HOLD") {
        if (group.some((h) => taken.has(h))) problems.push(`${group[0].scheme_name}: the review says ${r.deferred ? r.verdictText : "HOLD"} but it is in the sell list.`);
        const why = r.note ? `: ${r.note}` : "";
        for (const h of group) holdReason.set(h, (r.deferred ? `Exit later (not now)${why}` : `Keep${why}`).slice(0, 300));
      } else if (r.verdict === "ADD") {
        for (const h of group) holdReason.set(h, `Keep and ${r.verdictText.toLowerCase()} (see buy list)${r.note ? `: ${r.note}` : ""}`.slice(0, 300));
      }
    }
    for (const h of additional ? [] : live) {
      if (reviewed.has(h)) continue;
      if (tolerant) flagged.set(h, { kind: boughtInReport(h) ? "BUY_HELD" : "NOT_IN_REPORT", report: null });
      else problems.push(`${h.scheme_name} (folio ${h.folio_number ?? "—"}, ${inr(h.current_value)}) is in the CAS but not covered by the report.`);
    }
  }

  // ---- Other layouts: held/deferred funds (with values) and fund lists prove coverage. ----
  if (!report.review.length) {
    const covered = new Set<PlanHolding>(taken);
    const pick = (fund: string, folio: string | null, count: number, planType: "DIRECT" | "REGULAR" | null, value?: number): PlanHolding[] => {
      const known = viaAlias(fund, planType);
      if (known.length && (!folio || known.some((k) => normFolio(k.folio_number).startsWith(normFolio(folio))))) return known;
      if (folio) {
        const byFolio = live.filter((x) => normFolio(x.folio_number) === normFolio(folio) || (normFolio(x.folio_number).startsWith(normFolio(folio)) && normFolio(folio).length >= 6));
        const named = byFolio.filter((x) => samePlan(planType, x) && nameSimilarity(fund, x.scheme_name) >= 0.4);
        if (named.length === 1) return named;
      }
      const group = sameFundHoldings(fund, live, planType);
      if (count > 1 || group.length === 1) return group;
      // No folio named: the whole fund, unless the report's value is one folio's.
      if (!folio && value !== undefined) {
        const one = group.filter((x) => !covered.has(x) && sameValue(value, x.current_value));
        return one.length === 1 ? one : group;
      }
      return group.filter((x) => !covered.has(x)).slice(0, 1);
    };
    for (const hd of report.holds) {
      const byValue = hd.folioCount === 1 && sameStatement
        ? live.filter((x) => !covered.has(x) && samePlan(hd.planType, x) && sameValue(hd.value, x.current_value) && nameSimilarity(hd.fund, x.scheme_name) >= 0.4)
        : [];
      const group = byValue.length === 1 ? byValue : pick(hd.fund, hd.folio, hd.folioCount, hd.planType, hd.value);
      if (!group.length) {
        if (tolerant) {
          keepGone(hd.fund, hd.planType, hd.value, hd.note);
          continue;
        }
        problems.push(`The report keeps "${hd.fund}"${hd.folio ? ` (folio ${hd.folio})` : ""} (${inr(hd.value)}), but that fund is not in the CAS.`);
        continue;
      }
      const total = group.reduce((t, x) => t + x.current_value, 0);
      if (!valueOk(hd.value, total, group[0].scheme_name)) {
        if (tolerant) for (const g of group) flagged.set(g, { kind: "KEEP_CHANGED", report: hd.value });
        else problems.push(`${group[0].scheme_name}: the report values it at ${inr(hd.value)}, the CAS at ${inr(total)}.`);
      }
      for (const g of group) {
        if (taken.has(g)) problems.push(`${g.scheme_name}: the report both sells it and keeps it.`);
        covered.add(g);
        holdReason.set(g, `Kept for now: ${hd.note || "held / deferred in the report"}`.slice(0, 300));
        if (isMigrate(hd.note)) migrateTo.set(g, directName(hd.fund));
      }
    }
    for (const m of report.mentioned) {
      for (const g of pick(m.fund, m.folio, m.folioCount, m.planType)) {
        covered.add(g);
        if (m.note && !holdReason.has(g)) holdReason.set(g, m.note.slice(0, 300));
        if (isMigrate(m.note)) migrateTo.set(g, directName(m.fund));
      }
    }
    // Recommendations that could not be read as Buy / Sell / Keep: a Keep line with the question.
    for (const q of report.questions ?? []) {
      const group = pick(q.fund, q.folio, q.folioCount, q.planType).filter((g) => !taken.has(g));
      if (!group.length) {
        items.push({ action: "RETAIN", scheme_name: q.fund, isin: null, folio_number: q.folio, target_amount: 0, current_amount: null,
          reason: `Report: ${q.reportText}`.slice(0, 300), question: q.question, priority: (priority += 10), plan_type: q.planType });
        continue;
      }
      for (const g of group) {
        covered.add(g);
        asked.set(g, q);
      }
    }
    for (const x of [...report.sips.filter((z) => z.change !== "START").map((z) => ({ fund: z.fund, planType: z.planType })), ...report.buys.filter((b) => b.kind === "TOP_UP").map((b) => ({ fund: b.fund, planType: b.planType }))]) {
      const pt = x.planType ?? detectPlanType(x.fund);
      for (const g of [...viaAlias(x.fund, pt), ...sameFundHoldings(x.fund, live, pt)]) covered.add(g);
    }
    // Funds a second reader confirmed the report never mentions (named exactly as in the CAS)
    // are kept as they are and flagged, as long as together they are a small part of the portfolio.
    const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const absent = new Set((report.notInReport ?? []).map(norm));
    const uncovered = additional ? [] : live.filter((h) => !covered.has(h));
    const confirmed = uncovered.filter((h) => absent.has(norm(h.scheme_name)));
    const liveTotal = live.reduce((t, h) => t + h.current_value, 0);
    const confirmedTotal = confirmed.reduce((t, h) => t + h.current_value, 0);
    const keepConfirmed = confirmed.length > 0 && confirmedTotal <= liveTotal * NOT_IN_REPORT_LIMIT;
    for (const h of uncovered) {
      if (tolerant) {
        flagged.set(h, { kind: boughtInReport(h) ? "BUY_HELD" : "NOT_IN_REPORT", report: null });
        if (!holdReason.has(h)) holdReason.set(h, "Not mentioned in the report");
        continue;
      }
      if (keepConfirmed && confirmed.includes(h)) {
        unreported.push(`${h.scheme_name} (folio ${h.folio_number ?? "—"}, ${inr(h.current_value)})`);
        holdReason.set(h, "Not mentioned in the advisory report: kept as it is. Advisor to confirm.");
        continue;
      }
      problems.push(`${h.scheme_name} (folio ${h.folio_number ?? "—"}, ${inr(h.current_value)}) is in the CAS but not covered by the report.${
        confirmed.includes(h) ? ` The report does not mention it, but such funds are ${Math.round((confirmedTotal / Math.max(1, liveTotal)) * 100)}% of the portfolio (over ${NOT_IN_REPORT_LIMIT * 100}%): the advisor must decide.` : ""}`);
    }
  }

  for (const h of live) {
    if (taken.has(h)) continue;
    const q = asked.get(h);
    if (q) {
      items.push({ action: "RETAIN", scheme_name: h.scheme_name, isin: h.isin, folio_number: h.folio_number, target_amount: 0,
        current_amount: h.current_value, reason: `Report: ${q.reportText}`.slice(0, 300), question: q.question, priority: (priority += 10) });
      continue;
    }
    const to = migrateTo.get(h);
    if (to && holdingPlan(h) === "REGULAR") {
      items.push({
        action: "MIGRATE", scheme_name: h.scheme_name, isin: h.isin, folio_number: h.folio_number,
        target_amount: h.current_value, current_amount: h.current_value, switch_to_scheme_name: to,
        reason: (holdReason.get(h) ?? "Migrate to Direct").replace(/^Kept for now: /, ""), priority: (priority += 10), plan_type: "DIRECT",
      });
      continue;
    }
    if (additional) continue;
    const f = flagged.get(h);
    if (f?.kind === "BUY_HELD") continue; // the report's Buy line covers it (asked there)
    const keepIt: PlanItemDraft = { action: "RETAIN", scheme_name: h.scheme_name, isin: h.isin, folio_number: h.folio_number, target_amount: 0, current_amount: h.current_value, reason: holdReason.get(h) ?? "Not sold in the report", priority: (priority += 10) };
    items.push(keepIt);
    if (f) differs.set(keepIt, f);
  }

  // ---- Buys: new funds by name; a top-up must be a fund already held. ----
  for (const b of report.buys) {
    let planType = b.planType ?? detectPlanType(b.fund);
    const held = matchFund(b.fund, live, planType);
    if (!planType) {
      // Not stated: a top-up is the plan already held; a new fund is Direct (Univest is a SEBI RIA and advises Direct plans).
      planType = held ? holdingPlan(held) : "DIRECT";
      if (!held) drift.push(`${b.fund}: the report does not say Direct or Regular, so Direct is assumed (new money is advised in Direct plans).`);
    }
    if (b.kind === "TOP_UP" && !held && !tolerant) problems.push(`Buy row "${b.fund}" is marked top-up, but no ${planType ?? ""} holding of it is in the CAS.`.replace("  ", " "));
    const buyIt: PlanItemDraft = {
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
    };
    items.push(buyIt);
    // A newer CAS may already hold a fund the report buys new.
    if (tolerant && held && b.kind !== "TOP_UP") differs.set(buyIt, { kind: "BUY_HELD", report: b.amount });
  }

  // ---- Report vs a newer CAS: each difference, and each trade since the report, becomes a question. ----
  if (opts.since) {
    const cutoff = reportDate ?? report.preparedDate ?? null;
    const trades = opts.since.trades.filter((t) => t.type !== "SIP" && (!cutoff || t.date > cutoff));
    const isSell = (t: SinceTrade) => t.type === "REDEMPTION" || t.type === "SWITCH_OUT";
    const isBuy = (t: SinceTrade) => t.type === "PURCHASE" || t.type === "SWITCH_IN";
    const r2 = (n: number) => Math.round(n * 100) / 100;
    // Each trade counts once: Sell / Buy lines take their fund's trades first, then Keep lines.
    const used = new Set<SinceTrade>();
    const sameFund = (it: PlanItemDraft, isin: string | null, name: string) => (it.isin && isin ? it.isin === isin : nameSimilarity(it.scheme_name, name) >= 0.85);
    const ordered = [...items.filter((i) => i.action !== "RETAIN"), ...items.filter((i) => i.action === "RETAIN")];
    for (const it of ordered) {
      const mine = trades.filter((t) => !used.has(t) && sameFund(it, t.isin, t.scheme_name));
      mine.forEach((t) => used.add(t));
      // A Keep line whose change is its fund's Buy / Sell line (asked there) is not asked again.
      if (it.action === "RETAIN" && !mine.length && differs.get(it)?.kind === "KEEP_CHANGED"
          && items.some((o) => o !== it && o.action !== "RETAIN" && sameFund(o, it.isin, it.scheme_name))) continue;
      const sold = r2(mine.filter(isSell).reduce((t, x) => t + Math.abs(x.amount), 0));
      const bought = r2(mine.filter(isBuy).reduce((t, x) => t + Math.abs(x.amount), 0));
      const lastSell = mine.filter(isSell).map((x) => x.date).sort().pop() ?? null;
      const lastBuy = mine.filter(isBuy).map((x) => x.date).sort().pop() ?? null;
      const d = differs.get(it);
      // A Regular fund being migrated: only its redemption matters (a SIP into it is not a buy call).
      const migrating = it.action === "MIGRATE";
      if (!d && sold < 1 && (bought < 1 || migrating)) continue;
      const kind = d?.kind ?? "TRADED";
      const cas = it.current_amount ?? 0;
      const suggest: ReportDiff["suggest"] = it.action === "BUY" ? "BUY" : it.action === "SELL" || it.action === "SWITCH" || migrating ? "SELL"
        : sold >= 1 ? "SELL" : bought >= 1 ? "BUY" : "RETAIN";
      const done = suggest === "SELL" ? sold : suggest === "BUY" ? bought : 0;
      const since = [sold >= 1 ? `${inr(sold)} sold` : null, bought >= 1 ? `${inr(bought)} bought` : null].filter(Boolean).join(" and ");
      const sinceText = since ? `${since} since the report (last on ${[lastSell, lastBuy].filter(Boolean).sort().pop()})` : "no trade since the report";
      const rep = d?.report != null ? inr(d.report) : null;
      const asked = ({
        SELL_GONE: `The report sells ${rep ?? "this fund"}; the new CAS no longer holds it (${sinceText}). Was it sold on our advice?`,
        SELL_CHANGED: `The report sells ${rep ?? "this fund"}; the new CAS holds ${inr(cas)} (${sinceText}). How much is done, and how much is left to sell?`,
        KEEP_GONE: `The report keeps this fund${rep ? ` (${rep})` : ""}, but the new CAS no longer holds it (${sinceText}). Sold on our advice (Sell), or the client's own (Keep)?`,
        KEEP_CHANGED: `The report keeps this fund at ${rep ?? "its value"}; the new CAS holds ${inr(cas)} (${sinceText}). On our advice, or the client's own (Keep)?`,
        BUY_HELD: `The report buys ${rep ?? "this fund"}; the new CAS already holds ${inr(cas)} (${sinceText}). Already bought on our advice?`,
        NOT_IN_REPORT: `Not in the report, but the new CAS holds it (${inr(cas)}; ${sinceText}). Bought on our advice (Buy), or the client's own (Keep)?`,
        TRADED: `The new CAS shows ${sinceText}. Done on our advice?`,
      } as const)[kind];
      // A question the report itself raised (e.g. a trim with no amount) keeps its wording, with what the CAS shows.
      it.question = it.question ? `${it.question} The new CAS shows ${sinceText}.` : asked;
      it.diff = {
        kind, report_amount: d?.report ?? null, cas_value: r2(cas), sold_since: sold, bought_since: bought, suggest,
        done_amount: done, done_date: suggest === "SELL" ? lastSell : suggest === "BUY" ? lastBuy : null,
      };
    }
  }

  // ---- Report vs a newer CAS: trades of funds no line covers (the report named them differently, or not at all). ----
  if (opts.since) {
    const cutoff = reportDate ?? report.preparedDate ?? null;
    const covered = (t: SinceTrade) => items.some((i) => (i.isin && t.isin ? i.isin === t.isin : nameSimilarity(i.scheme_name, t.scheme_name) >= 0.85));
    const left = opts.since.trades.filter((t) => t.type !== "SIP" && (!cutoff || t.date > cutoff) && !covered(t));
    const funds = new Map<string, SinceTrade[]>();
    for (const t of left) funds.set(t.isin ?? t.scheme_name.toLowerCase(), [...(funds.get(t.isin ?? t.scheme_name.toLowerCase()) ?? []), t]);
    for (const ts of funds.values()) {
      const sold = Math.round(ts.filter((t) => t.type === "REDEMPTION" || t.type === "SWITCH_OUT").reduce((a, t) => a + Math.abs(t.amount), 0) * 100) / 100;
      const bought = Math.round(ts.filter((t) => t.type === "PURCHASE" || t.type === "SWITCH_IN").reduce((a, t) => a + Math.abs(t.amount), 0) * 100) / 100;
      if (sold < 1 && bought < 1) continue;
      const suggest = sold >= bought ? "SELL" : "BUY";
      const date = ts.map((t) => t.date).sort().pop() ?? null;
      const what = [sold >= 1 ? `${inr(sold)} sold` : null, bought >= 1 ? `${inr(bought)} bought` : null].filter(Boolean).join(" and ");
      items.push({
        action: "RETAIN", scheme_name: ts[0].scheme_name, isin: ts[0].isin, folio_number: null, target_amount: 0, current_amount: 0,
        reason: "Not in the report", priority: (priority += 10),
        question: `Not in the report under this name; the new CAS shows ${what} since the report (last on ${date}). On our advice (the report may call it by another name), or the client's own (Keep)?`,
        diff: { kind: "TRADED", report_amount: null, cas_value: 0, sold_since: sold, bought_since: bought, suggest,
          done_amount: suggest === "SELL" ? sold : bought, done_date: date },
      });
    }
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
    let planType = s.planType ?? detectPlanType(s.fund) ?? buy?.plan_type ?? null;
    const known = viaAlias(s.fund, planType);
    const h = matchFund(s.fund, live, planType) ?? (known.length ? { ...known[0], folio_number: known.length === 1 ? known[0].folio_number : null } : null);
    if (!planType && h) planType = holdingPlan(h);
    if (!planType && s.change === "START") {
      planType = "DIRECT";
      drift.push(`New SIP in ${s.fund}: the report does not say Direct or Regular, so Direct is assumed.`);
    }
    if (s.change !== "START" && !h) {
      if (tolerant) {
        // Report vs a newer CAS: the fund is already exited, so its SIP has nothing left to stop.
        drift.push(`SIP ${s.change === "STOP" ? "stop" : "change"} for ${s.fund}: the new CAS no longer holds the fund (already exited).`);
        continue;
      }
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

  // Fresh money must pay for the buys not funded by sells.
  let freshMoney: number | null = null;
  if (additional) {
    const sells = items.filter((i) => i.action === "SELL" || i.action === "SWITCH").reduce((t, i) => t + i.target_amount, 0);
    const buys = items.filter((i) => i.action === "BUY").reduce((t, i) => t + i.target_amount, 0);
    const needed = Math.round((buys - sells) * 100) / 100;
    freshMoney = report.freshMoney ?? (needed > 0 ? needed : null);
    if (report.freshMoney != null && Math.abs(needed - report.freshMoney) > Math.max(1000, report.freshMoney * 0.01)) {
      problems.push(`The report invests ${inr(report.freshMoney)} of fresh money, but its buys minus sells come to ${inr(needed)}.`);
    }
    if (!buys && !items.length && !sip_items.length) problems.push("The additional-investment report has no buy, sell or SIP line.");
  }

  const notes = [
    additional ? `Additional investment${freshMoney ? ` of ${inr(freshMoney)} fresh money` : ""}: approving adds these lines to the active plan as a new tranche.` : null,
    `Imported from the advisory report${report.preparedDate ? ` prepared ${report.preparedDate}` : ""}.`,
    report.riskProfile ? `Risk profile: ${report.riskProfile}.` : null,
    report.goal ? `Goal: ${report.goal}.` : null,
    ...report.deploymentNotes.map((n) => `• ${n}`),
    ...(drift.length ? ["NAV movement since the report:", ...drift.map((d) => `• ${d}`)] : []),
    ...(unreported.length ? ["Not mentioned in the report (kept as they are; please confirm):", ...unreported.map((d) => `• ${d}`)] : []),
  ].filter(Boolean).join("\n");

  return {
    plan_name: `${additional ? "Additional investment" : "Rebalancing plan"}${report.preparedDate ? ` · ${report.preparedDate}` : ""}`,
    plan_kind: additional ? "ADDITIONAL" : "FULL",
    fresh_money: freshMoney,
    plan_date: report.preparedDate,
    starting_portfolio_value: report.currentValue,
    items,
    sip_items,
    declared_totals: { exit_value: report.sellTotal, buy_value: report.buyTotal },
    notes,
    // An older CAS explains every other difference: say that one thing.
    problems: staleCas ? [staleCas] : problems,
    drift,
    warnings: staleCas ? [staleCas] : problems,
  };
}

// ---- One wording for a migration / switch stored as Sell + Buy (report import, checker, Keep-note conversion). ----
/** "X Fund - Regular Plan - Growth" -> "X Fund - Direct Plan - Growth" (a name; the AMFI match is looked up separately). */
export function directPlanName(fund: string): string {
  return withPlanType(fund.replace(/\s*[-(]?\s*\b(regular|reg)\b(\s+plan)?\s*\)?/gi, " ").replace(/\s+/g, " ").trim(), "DIRECT");
}
export const MIGRATE_BUY_REASON = "Migrate to Direct: buy the Direct plan with the Regular redemption";
export const switchBuyReason = (from: string) => `Switch: buy with the money from ${from}`;
/** The Sell leg's reason, keeping what the report said after "Migrate to Direct" ("Hold", "Consolidate"). */
export function migrateSellReason(reportReason: string | null | undefined): string {
  const rest = (reportReason ?? "").replace(/^(Kept for now: )?(Migrate to Direct;?\s*)?/i, "").trim();
  return `Migrate to Direct: redeem the Regular plan${rest ? `; ${rest}` : ""}`;
}

/**
 * The draft as the plan stores it: Buy, Sell or Keep. A Migrate to Direct is a
 * Sell of the Regular plan and a Buy of the Direct plan (same amount); a Switch
 * is a Sell (plus a Buy of the fund it goes to, when named). Mirrors the ingest
 * in services/plans.ts.
 */
export function asBuySellKeep(items: PlanItemDraft[]): (PlanItemDraft & { action: "SELL" | "BUY" | "RETAIN" })[] {
  const out: (PlanItemDraft & { action: "SELL" | "BUY" | "RETAIN" })[] = [];
  for (const i of items) {
    if (i.action !== "MIGRATE" && i.action !== "SWITCH") {
      out.push({ ...i, action: i.action });
      continue;
    }
    out.push({ ...i, action: "SELL", switch_to_scheme_name: null, reason: i.action === "MIGRATE" ? migrateSellReason(i.reason) : i.reason });
    if (i.switch_to_scheme_name && i.target_amount > 0) {
      out.push({
        action: "BUY", scheme_name: i.switch_to_scheme_name, isin: null, folio_number: null, target_amount: i.target_amount, current_amount: null,
        reason: i.action === "MIGRATE" ? MIGRATE_BUY_REASON : switchBuyReason(i.scheme_name),
        priority: i.priority + 1, plan_type: i.action === "MIGRATE" ? "DIRECT" : i.plan_type ?? null,
      });
    }
  }
  return out;
}
