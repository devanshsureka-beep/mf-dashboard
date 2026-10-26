/**
 * Quarterly review (the "69 report"): the pure arithmetic. No database, no network.
 *
 * - Same rupees, same dates: replay a fund's cash flows into another scheme (an index
 *   fund) at that scheme's NAV on each date, and value both on the review date.
 * - XIRR, only shown when there is a year of history (under a year: absolute only).
 * - Capital gains by lot, oldest units sold first (FIFO), with the FY's ₹1.25L equity
 *   exemption counted once across all funds.
 * - Projections: today's value plus the monthly SIP, compounded monthly at planning rates.
 * - Plan-line status and the checks run before a PDF may be downloaded.
 */

export interface NavPoint { date: string; nav: number }
/** Money into a fund (+) or out of it (−), on a date. */
export interface Flow { date: string; amount: number }

const DAY = 86_400_000;
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
export const daysBetween = (a: string, b: string) => Math.round((ms(b) - ms(a)) / DAY);

export function addMonths(date: string, months: number): string {
  const d = new Date(ms(date));
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

/**
 * NAV on a date: the last NAV on or before it (a holiday takes the previous day's NAV).
 * A date before the series starts has no NAV, unless the first NAV is within `graceDays` after it.
 */
export function navOn(series: readonly NavPoint[] | undefined, date: string, graceDays = 5): number | null {
  if (!series?.length) return null;
  let lo = 0;
  let hi = series.length - 1;
  if (series[0].date > date) return daysBetween(date, series[0].date) <= graceDays ? series[0].nav : null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (series[mid].date <= date) lo = mid;
    else hi = mid - 1;
  }
  return series[lo].nav;
}

/** % change of a series between two dates (null when either NAV is missing). */
export function pctChange(series: readonly NavPoint[] | undefined, from: string, to: string): number | null {
  const a = navOn(series, from);
  const b = navOn(series, to);
  return a && b ? b / a - 1 : null;
}

/**
 * The same flows put into `series` on the same dates, valued on `asOf`.
 * Returns null when any flow has no NAV (the comparison would be wrong, not just rough).
 */
export function replay(flows: readonly Flow[], series: readonly NavPoint[] | undefined, asOf: string): { invested: number; value: number } | null {
  let units = 0;
  let invested = 0;
  for (const f of flows) {
    const nav = navOn(series, f.date);
    if (!nav) return null;
    units += f.amount / nav;
    invested += f.amount;
  }
  const end = navOn(series, asOf);
  if (!end) return null;
  return { invested, value: Math.max(0, units) * end };
}

/**
 * XIRR: the yearly rate that makes the flows' present value zero. Money put in is negative,
 * money out (and today's value) positive. Null when it does not converge or the flows are one-sided.
 */
export function xirr(flows: readonly Flow[]): number | null {
  const f = flows.filter((x) => Number.isFinite(x.amount) && x.amount !== 0);
  if (!f.some((x) => x.amount < 0) || !f.some((x) => x.amount > 0)) return null;
  const t0 = Math.min(...f.map((x) => ms(x.date)));
  const yrs = f.map((x) => (ms(x.date) - t0) / (365 * DAY));
  const npv = (r: number) => f.reduce((s, x, i) => s + x.amount / (1 + r) ** yrs[i], 0);
  // Bisection on a wide bracket: slow but never diverges.
  let lo = -0.99;
  let hi = 10;
  let flo = npv(lo);
  if (flo * npv(hi) > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid);
    if (Math.abs(fm) < 1e-7 || hi - lo < 1e-9) return mid;
    if (fm * flo < 0) hi = mid;
    else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------
// Tax: lots, oldest first
// ---------------------------------------------------------------------------

/** How a fund's gains are taxed. EQUITY: long-term after 12 months (12.5% above the shared ₹1.25L), else 20%.
 *  LONG24: gold, silver, overseas and other non-debt funds: long-term after 24 months (12.5%), else slab.
 *  SLAB: debt bought from April 2023: always at the slab rate. */
export type TaxClass = "EQUITY" | "LONG24" | "SLAB";

export function taxClassOf(assetClass: string, category: string | null, name: string): TaxClass {
  const s = `${category ?? ""} ${name}`.toLowerCase();
  if (assetClass === "Equity") return "EQUITY";
  // Equity-taxed hybrids hold 65%+ in Indian shares.
  if (/arbitrage|equity savings|aggressive|balanced advantage|dynamic asset allocation/.test(s)) return "EQUITY";
  if (/liquid|overnight|money market|debt|bond|gilt|credit|duration|income|treasury|psu|banking and psu|floater/.test(s)) return "SLAB";
  return "LONG24";
}

export const EQUITY_LTCG_EXEMPTION = 125_000;
export const LTCG_RATE = 0.125;
export const STCG_EQUITY_RATE = 0.2;

export interface LotTxn { date: string; units: number; amount: number }
export interface Lot { date: string | null; units: number; costPerUnit: number | null }
export interface Realised { date: string; units: number; proceeds: number; cost: number | null; gain: number | null; term: "LT" | "ST" | "UNKNOWN" }

const longTermAfterDays = (c: TaxClass) => (c === "EQUITY" ? 365 : c === "LONG24" ? 730 : Infinity);

/**
 * Walk one fund's buys (+units) and sells (−units) oldest first. `openingUnits` are units held before
 * the first transaction we have (the CAS history starts later): they are sold first, with no known date
 * or cost, so their gain is UNKNOWN.
 */
export function fifo(txns: readonly LotTxn[], cls: TaxClass, openingUnits = 0): { lots: Lot[]; realised: Realised[] } {
  const lots: Lot[] = openingUnits > 1e-6 ? [{ date: null, units: openingUnits, costPerUnit: null }] : [];
  const realised: Realised[] = [];
  const sorted = [...txns].sort((a, b) => a.date.localeCompare(b.date) || b.units - a.units);
  for (const t of sorted) {
    if (t.units > 0) {
      lots.push({ date: t.date, units: t.units, costPerUnit: t.amount / t.units });
      continue;
    }
    let left = -t.units;
    const pricePerUnit = t.units ? Math.abs(t.amount / t.units) : 0;
    while (left > 1e-6 && lots.length) {
      const lot = lots[0];
      const take = Math.min(lot.units, left);
      const proceeds = take * pricePerUnit;
      const cost = lot.costPerUnit == null ? null : take * lot.costPerUnit;
      const term = lot.date == null ? "UNKNOWN" : daysBetween(lot.date, t.date) > longTermAfterDays(cls) ? "LT" : "ST";
      realised.push({ date: t.date, units: take, proceeds, cost, gain: cost == null ? null : proceeds - cost, term });
      lot.units -= take;
      left -= take;
      if (lot.units <= 1e-6) lots.shift();
    }
  }
  return { lots, realised };
}

/** Indian financial year (April–March) that a date falls in: start and end. */
export function fyOf(date: string): { start: string; end: string; label: string } {
  const y = Number(date.slice(0, 4));
  const startYear = Number(date.slice(5, 7)) >= 4 ? y : y - 1;
  return { start: `${startYear}-04-01`, end: `${startYear + 1}-03-31`, label: `FY${String(startYear + 1).slice(2)}` };
}

export interface FyGains { equityLt: number; equitySt: number; long24Lt: number; slab: number; unknownProceeds: number; exemptionLeft: number; estTax: number }

/** The FY's realised gains by bucket and an estimate of the tax (slab income left out: it depends on the client). */
export function fyGains(rows: readonly (Realised & { cls: TaxClass })[], fy: { start: string; end: string }): FyGains {
  const inFy = rows.filter((r) => r.date >= fy.start && r.date <= fy.end);
  const sum = (p: (r: (typeof inFy)[number]) => boolean) => inFy.filter(p).reduce((s, r) => s + (r.gain ?? 0), 0);
  const equityLt = sum((r) => r.cls === "EQUITY" && r.term === "LT");
  const equitySt = sum((r) => r.cls === "EQUITY" && r.term === "ST");
  const long24Lt = sum((r) => r.cls === "LONG24" && r.term === "LT");
  const slab = sum((r) => r.term !== "UNKNOWN" && (r.cls === "SLAB" || (r.cls === "LONG24" && r.term === "ST")));
  const unknownProceeds = inFy.filter((r) => r.term === "UNKNOWN").reduce((s, r) => s + r.proceeds, 0);
  const exemptionLeft = Math.max(0, EQUITY_LTCG_EXEMPTION - Math.max(0, equityLt));
  const estTax = Math.max(0, equityLt - EQUITY_LTCG_EXEMPTION) * LTCG_RATE + Math.max(0, equitySt) * STCG_EQUITY_RATE + Math.max(0, long24Lt) * LTCG_RATE;
  return { equityLt, equitySt, long24Lt, slab, unknownProceeds, exemptionLeft, estTax };
}

/** Lots that turn long-term between two dates (worth waiting for before a sale). */
export function lotsTurningLong(lots: readonly Lot[], cls: TaxClass, from: string, to: string): { date: string; units: number }[] {
  const days = longTermAfterDays(cls);
  if (!Number.isFinite(days)) return [];
  return lots.filter((l) => l.date).map((l) => ({ date: addDaysIso(l.date!, days + 1), units: l.units })).filter((x) => x.date > from && x.date <= to);
}

export function addDaysIso(date: string, days: number): string {
  return new Date(ms(date) + days * DAY).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

export const PROJECTION_YEARS = [1, 3, 5, 10, 15, 20] as const;
export interface Rates { bear: number; nifty: number; base: number; moonshot: number }
export const DEFAULT_RATES: Rates = { bear: 0.065, nifty: 0.11, base: 0.14, moonshot: 0.187 };

/** Value after `years` of today's value plus a monthly SIP, compounding monthly at a yearly rate. */
export function projectValue(start: number, monthlySip: number, rate: number, years: number): number {
  const n = Math.round(years * 12);
  const r = (1 + rate) ** (1 / 12) - 1;
  const grow = (1 + r) ** n;
  return start * grow + (r === 0 ? monthlySip * n : monthlySip * ((grow - 1) / r));
}

/** Years (to one decimal) until the base path crosses a target, or null within 40 years. */
export function yearsToReach(target: number, start: number, monthlySip: number, rate: number): number | null {
  if (start >= target) return 0;
  for (let m = 1; m <= 480; m++) if (projectValue(start, monthlySip, rate, m / 12) >= target) return Math.round((m / 12) * 10) / 10;
  return null;
}

// ---------------------------------------------------------------------------
// Dates of a review
// ---------------------------------------------------------------------------

/** The quarter-end (31 Mar, 30 Jun, 30 Sep, 31 Dec) on or before a date. */
export function quarterEndOnOrBefore(date: string): string {
  const y = Number(date.slice(0, 4));
  const ends = [`${y - 1}-12-31`, `${y}-03-31`, `${y}-06-30`, `${y}-09-30`, `${y}-12-31`];
  return ends.filter((e) => e <= date).pop()!;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "12 Oct" or "12 Oct 2026" (fixed English month names: no locale "Sept"). */
export function dayMon(date: string, year = false): string {
  const [y, m, d] = date.slice(0, 10).split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1]}${year ? ` ${y}` : ""}`;
}

export function isQuarterEnd(d: string): boolean {
  return /^\d{4}-(03-31|06-30|09-30|12-31)$/.test(d);
}

export function quarterLabel(quarterEnd: string): string {
  const m = Number(quarterEnd.slice(5, 7));
  const y = quarterEnd.slice(0, 4);
  return { 3: `Jan–Mar ${y}`, 6: `Apr–Jun ${y}`, 9: `Jul–Sep ${y}`, 12: `Oct–Dec ${y}` }[m] ?? quarterEnd;
}

/** Next review: the middle of the month after the next quarter-end ("Mid-January 2027"). */
export function nextReviewLabel(quarterEnd: string): string {
  const next = addMonths(quarterEnd.slice(0, 8) + "01", 4);
  const month = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(ms(next)));
  return `Mid-${month}`;
}

// ---------------------------------------------------------------------------
// Plan lines and checks
// ---------------------------------------------------------------------------

export type LineStatus = "DONE" | "PARTLY" | "NOT DONE" | "CONFIRM" | "NOT IN PLAN";

/** A plan line against what happened: CAS-backed `done`, `approved` = done by hand, no CAS yet. */
export function lineStatus(planned: number, done: number, approved: number): LineStatus {
  const tol = Math.max(1, planned * 0.02);
  if (done >= planned - tol) return "DONE";
  if (approved > 0.5 && done + approved >= planned - tol) return "CONFIRM";
  if (done + approved > 0.5) return "PARTLY";
  return "NOT DONE";
}

/** Internal model names that never go in a client's PDF. */
const FORBIDDEN: { re: RegExp; label: string }[] = [
  { re: /super\s*jager\s*bomb/i, label: "Super Jagerbomb" },
  { re: /jager\s*bomb/i, label: "Jagerbomb" },
  { re: /mf\s*bomb/i, label: "MF Bomb" },
  { re: /\bgate\s*(10|[1-9])\b/i, label: "gate number" },
  { re: /\bG(10|[1-9])\b/, label: "gate number" },
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Every forbidden term and every other client's name found in the text. Names shorter than two
 * words or 6 letters are skipped (too likely to be ordinary words).
 */
export function scanForbidden(text: string, otherClientNames: readonly string[]): string[] {
  const found = new Set<string>();
  for (const f of FORBIDDEN) if (f.re.test(text)) found.add(f.label);
  for (const raw of otherClientNames) {
    const name = raw.trim().replace(/\s+/g, " ");
    if (name.length < 6 || name.split(" ").length < 2) continue;
    if (new RegExp(`(^|[^\\p{L}])${escapeRe(name).replace(/ /g, "\\s+")}($|[^\\p{L}])`, "iu").test(text)) found.add(`another client's name (${name})`);
  }
  return [...found];
}

/** Totals that must agree, within a rupee per line. */
export function reconciles(parts: readonly number[], total: number, tolerance = 1): boolean {
  const sum = parts.reduce((s, x) => s + x, 0);
  return Math.abs(sum - total) <= Math.max(tolerance, parts.length);
}
