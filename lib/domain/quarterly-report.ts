/**
 * The quarterly review's content, page by page, from the client's raw numbers (gathered by
 * services/quarterly-review.ts), past NAVs and the advisor's inputs. Pure: the same data
 * always gives the same report, so it is unit-tested and the PDF only lays it out.
 *
 * Wording follows the client-facing rules: no internal model names, under a year is
 * absolute (never annualised), laggards and a switch that did worse are said plainly.
 */
import { formatINR, formatINRCompact } from "@/lib/format";
import { assetClass } from "./book";
import { marketCap, mix, type CapBucket, type MixRow } from "./market-cap";
import {
  DEFAULT_RATES, addDaysIso, dayMon, daysBetween, fifo, fyGains, fyOf, lineStatus, lotsTurningLong, navOn, nextReviewLabel, pctChange,
  projectValue, PROJECTION_YEARS, quarterLabel, reconciles, replay, scanForbidden, taxClassOf, xirr, yearsToReach,
  type FyGains, type LineStatus, type LotTxn, type NavPoint, type Rates, type Realised, type TaxClass,
} from "./quarterly";
import { valuationRead, type FundStatus, type MarketContext, type QuarterlyInputs } from "./quarterly-inputs";

// ---------------------------------------------------------------------------
// Raw input
// ---------------------------------------------------------------------------

export interface RawFund {
  key: string; isin: string | null; amfi: string | null; name: string; category: string | null; amc: string | null;
  units: number; value: number; cost: number; casValue: number; nav: number | null;
}
/** A CAS transaction or an approved trade not yet in a CAS: units and amount are positive. */
export interface RawTxn { key: string; name: string; date: string; side: "BUY" | "SELL"; units: number | null; amount: number; approved?: boolean }
export interface RawPlanLine {
  key: string; name: string; side: "SELL" | "BUY"; planned: number; doneCas: number; approved: number; left: number;
  reason: string | null; advisedOn: string | null; doneOn: string | null;
}
export interface RawSip { id: string; key: string; name: string; category: string | null; action: "START" | "STOP" | "CHANGE"; oldAmount: number; newAmount: number; status: string; notes: string | null }
export interface Benchmark { code: string; name: string; amfi: string }
/** Funds no longer held that were sold in the window or this FY: today's NAV and what we know of them. */
export interface RawSoldFund { key: string; name: string; category: string | null; amfi: string | null; nav: number | null }

export interface RawReview {
  client: { id: string; name: string; code: string };
  quarterEnd: string;
  today: string;
  asOf: string;
  casDate: string;
  windowStart: string;
  reviewNo: number;
  planName: string | null;
  funds: RawFund[];
  sold: RawSoldFund[];
  txns: RawTxn[];
  planLines: RawPlanLine[];
  /** Plan lines not advised yet + calls still waiting, for "after" (signed: sells negative). */
  planDeltas: MixRow[];
  sips: RawSip[];
  ownTrades: { date: string; name: string; amount: number; side: "BUY" | "SELL" }[];
  baseline: MixRow[];
  sipMonthly: number;
  navs: Map<string, NavPoint[]>;
  benchmarks: Benchmark[];
  /** Advisor's choice of index per fund (key → code, null = no comparison); missing = default. */
  fundIndex: Record<string, string | null>;
  otherClientNames: string[];
  market: MarketContext;
  navFailed: string[];
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface HealthRow { key: string; isin: string | null; index: string | null; indexIsDefault: boolean; name: string; value: number; weight: number; onCost: number | null; sinceCas: number | null; status: FundStatus | null; why: string }
export interface ScoreRow { key: string; name: string; newIn: number; worth: number; ret: number; index: string | null; ahead: number | null }
export interface PlanRow { what: string; detail: string; status: LineStatus | "NOTE" }
export interface RebalanceSell { key: string; name: string; units: number | null; value: number; gain: number | null }
export interface RebalanceBuy { key: string; name: string; amount: number; mode: string; fundedBy: string; why: string; lumpsum: "OPEN" | "PAUSED"; sip: "OPEN" | "PAUSED" }
export interface SipRow { id: string; name: string; category: string; amount: number; action: string; why: string; status: string }
export interface TaxLine { name: string; value: number; cost: number | null; gain: number | null; treatment: string }
export interface Action { title: string; detail: string; when: string }

export interface QuarterlyReport {
  client: RawReview["client"];
  quarterEnd: string; quarterLabel: string; reviewNo: number;
  windowStart: string; windowEnd: string; asOf: string; casDate: string; prepared: string;
  texts: {
    tagline: string; headline: string; glance: string[]; storySentence: string; marketNote: string; planCallout: string;
    winnersNote: string; laggardNote: string; oldVsNewNote: string; rebalanceNote: string; structureNote: string; sipNote: string;
    taxNotes: string[]; nextReview: string; nextReviewNote: string;
  };
  story: { when: string; title: string; text: string }[];
  totals: { value: number; cost: number; gain: number; gainPct: number; casValue: number; sinceCas: number; sinceCasPct: number; funds: number; xirr: number | null; years: number };
  money: { deployed: number; recycled: number; fresh: number; worth: number; ret: number | null; niftyWorth: number | null; niftyRet: number | null; aheadOfNifty: number | null; niftySinceStart: number | null; indexAsOf: string | null };
  health: HealthRow[];
  score: { rows: ScoreRow[]; total: { newIn: number; worth: number; ret: number }; ahead: number; compared: number };
  plan: { rows: PlanRow[]; done: number; total: number };
  old: { rows: { name: string; units: number; soldFor: number; worthIfKept: number; ret: number }[]; soldFor: number; worthIfKept: number; oldRet: number; newRows: { name: string; putIn: number; worth: number; ret: number }[]; newWorth: number; newRet: number; added: number; bookIfKept: number } | null;
  rebalance: { sells: RebalanceSell[]; buys: RebalanceBuy[]; redeemed: number; reinvested: number; topAmc: { name: string; now: number; after: number } | null } | null;
  structure: { rows: { label: CapBucket; before: number | null; now: number; after: number }[]; amc: { name: string; now: number; after: number }[]; changes: boolean };
  sip: { rows: SipRow[]; fromNext: number; lastQuarter: number; noNewMoney: string[] };
  market: { moves: { label: string; pct: number }[]; valuations: { index: string; peNow: number; median: number; gap: number; read: string }[]; asOf: string | null };
  tax: { fy: string; gains: FyGains; lines: TaxLine[]; estTax: number; exitLoad: number; historyFrom: string | null; unknownLots: boolean; turningLong: { date: string; name: string; value: number }[] };
  projections: { start: number; sip: number; rates: Rates; rows: { label: string; key: keyof Rates | "invested"; values: number[] }[]; crossesCrore: number | null };
  actions: Action[];
  checks: { errors: string[]; warnings: string[] };
}

// ---------------------------------------------------------------------------

const sum = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);
const full = (x: number) => formatINR(x).replace("-", "−");
const pctTxt = (x: number | null, d = 1) => (x == null ? "—" : `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(d)}%`);
const money = (x: number) => formatINRCompact(x).replace("-", "−");
const dayMonth = (d: string) => dayMon(d);
const monthName = (d: string) => new Intl.DateTimeFormat("en-IN", { month: "long", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`));
/** "Alpha Mid Cap Fund - Direct Plan - IDCW Reinvest" → "Alpha Mid Cap — IDCW Reinvest": short, but two share classes stay apart. */
export function shortName(n: string): string {
  const [head, ...rest] = n.split(/\s+-\s+/);
  const tail = rest.join(" ");
  const flags = [/\bregular\b/i.test(tail) ? "Regular" : null, /reinvest/i.test(tail) ? "IDCW Reinvest" : /idcw|dividend|payout/i.test(tail) ? "IDCW" : null].filter(Boolean);
  const base = head.replace(/\s+/g, " ").trim().replace(/(?<!fund of)\s+(fund|scheme)$/i, "");
  return flags.length ? `${base} — ${flags.join(", ")}` : base;
}

/** The index a fund is compared with by default: its market-cap group (index funds by their index). */
export function defaultIndex(category: string | null, name: string): string | null {
  const n = name.toLowerCase();
  if (/index|etf/.test(n)) {
    if (/next 50/.test(n)) return "NIFTYNEXT50";
    if (/nifty ?50\b/.test(n)) return "NIFTY50";
    if (/nifty ?100\b/.test(n)) return "NIFTY100";
    if (/bank/.test(n)) return "NIFTYBANK";
  }
  const cap = marketCap(category, name);
  return ({ "Large cap": "NIFTY100", "Large & mid": "LARGEMIDCAP250", "Mid cap": "MIDCAP150", "Small cap": "SMALLCAP250", "Flexi / multi": "NIFTY500" } as Partial<Record<CapBucket, string>>)[cap] ?? null;
}

export function buildQuarterlyReport(raw: RawReview, inputs: QuarterlyInputs): QuarterlyReport {
  const { asOf, casDate, windowStart } = raw;
  const warnings: string[] = [];
  const errors: string[] = [];
  const bench = new Map(raw.benchmarks.map((b) => [b.code, b]));
  const nifty = bench.get("NIFTY50");
  const niftySeries = nifty ? raw.navs.get(nifty.amfi) : undefined;
  const fundOf = new Map(raw.funds.map((f) => [f.key, f]));
  const soldOf = new Map(raw.sold.map((s) => [s.key, s]));
  const navNow = (key: string) => fundOf.get(key)?.nav ?? soldOf.get(key)?.nav ?? null;
  const nameOf = (key: string, fallback: string) => shortName(fundOf.get(key)?.name ?? soldOf.get(key)?.name ?? fallback);
  const categoryOf = (key: string) => fundOf.get(key)?.category ?? soldOf.get(key)?.category ?? null;

  // ---- Holdings -----------------------------------------------------------
  const value = sum(raw.funds.map((f) => f.value));
  const cost = sum(raw.funds.map((f) => f.cost));
  const casValue = sum(raw.funds.map((f) => f.casValue));
  if (!raw.funds.length) errors.push("No holdings: confirm a CAS for this client first.");

  // ---- Money in the window (CAS trades + approved trades after the CAS) ---
  // Trades up to today count (a trade after the latest NAV date is valued at that NAV).
  const windowEnd = raw.today > asOf ? raw.today : asOf;
  const inWindow = raw.txns.filter((t) => t.date >= windowStart && t.date <= windowEnd);
  const unitsOf = (t: RawTxn) => {
    if (t.units && t.units > 0) return t.units;
    const fund = fundOf.get(t.key) ?? soldOf.get(t.key);
    const nav = (fund?.amfi && navOn(raw.navs.get(fund.amfi), t.date)) || navNow(t.key);
    return nav ? t.amount / nav : 0;
  };
  const buys = inWindow.filter((t) => t.side === "BUY");
  const sells = inWindow.filter((t) => t.side === "SELL");
  const deployed = sum(buys.map((t) => t.amount));
  const recycled = sum(sells.map((t) => t.amount));

  // ---- Scorecard: every fund that got new money ---------------------------
  const keys = [...new Set(buys.map((t) => t.key))];
  let indexAsOf: string | null = null;
  const unpriced: string[] = [];
  const rows: ScoreRow[] = keys.map((key) => {
    const b = buys.filter((t) => t.key === key);
    const s = sells.filter((t) => t.key === key);
    const newIn = sum(b.map((t) => t.amount));
    const boughtUnits = sum(b.map(unitsOf));
    const heldUnits = (fundOf.get(key)?.units ?? 0) + sum(b.filter((t) => t.approved).map(unitsOf)) - sum(s.filter((t) => t.approved).map(unitsOf));
    const soldUnits = Math.max(0, boughtUnits - Math.max(0, heldUnits));
    const sellPrice = sum(s.map(unitsOf)) > 0 ? sum(s.map((t) => t.amount)) / sum(s.map(unitsOf)) : navNow(key) ?? 0;
    // No NAV at all for this fund (not in the daily NAV list): value it at cost and say so.
    const priced = navNow(key) != null && boughtUnits > 0;
    if (!priced) unpriced.push(nameOf(key, b[0].name));
    const worth = priced ? (boughtUnits - soldUnits) * (navNow(key) ?? 0) + soldUnits * sellPrice : newIn;
    const code = key in raw.fundIndex ? raw.fundIndex[key] : defaultIndex(categoryOf(key), nameOf(key, ""));
    const bm = code ? bench.get(code) : undefined;
    const series = bm ? raw.navs.get(bm.amfi) : undefined;
    const rep = series ? replay(b.map((t) => ({ date: t.date, amount: t.amount })), series, asOf) : null;
    if (series?.length) {
      const last = series.filter((p) => p.date <= asOf).pop()?.date ?? null;
      if (last && (!indexAsOf || last < indexAsOf)) indexAsOf = last;
    }
    return { key, name: nameOf(key, b[0].name), newIn, worth, ret: newIn ? worth / newIn - 1 : 0, index: bm?.name ?? null, ahead: rep ? worth - rep.value : null };
  }).sort((a, b) => b.newIn - a.newIn);
  const worthAll = sum(rows.map((r) => r.worth));
  if (unpriced.length) warnings.push(`No NAV for ${unpriced.join(", ")}: valued at cost. Check the fund is in the daily NAV list.`);
  const newRet = deployed ? worthAll / deployed - 1 : null;
  const niftyRep = niftySeries && buys.length ? replay(buys.map((t) => ({ date: t.date, amount: t.amount })), niftySeries, asOf) : null;
  const compared = rows.filter((r) => r.ahead != null);
  if (buys.length && !niftyRep) warnings.push("Nifty 50 history is not available yet: the Nifty comparison is left blank.");
  const noIndex = rows.filter((r) => r.index && r.ahead == null).map((r) => r.name);
  if (noIndex.length) warnings.push(`Index history missing for: ${noIndex.join(", ")}. Their index column is blank.`);
  if (raw.navFailed.length) warnings.push(`Could not fetch past NAVs for ${raw.navFailed.length} scheme(s) (AMFI codes ${raw.navFailed.join(", ")}); try again later.`);
  if (indexAsOf && daysBetween(indexAsOf, asOf) > 7) warnings.push(`Index NAVs run to ${dayMonth(indexAsOf)} only; the comparison is to that date.`);

  // ---- Totals --------------------------------------------------------------
  const allFlows = raw.txns.filter((t) => t.date <= asOf).map((t) => ({ date: t.date, amount: t.side === "BUY" ? -t.amount : t.amount }));
  const firstTxn = raw.txns.map((t) => t.date).sort()[0] ?? null;
  const years = firstTxn ? daysBetween(firstTxn, asOf) / 365 : 0;
  // Lifetime XIRR only with a full year of history, and only when the history explains the book.
  const explained = Math.abs(sum(raw.txns.filter((t) => t.side === "BUY").map((t) => t.amount)) - sum(raw.txns.filter((t) => t.side === "SELL").map((t) => t.amount)) - cost) < Math.max(5000, cost * 0.05);
  const lifetimeXirr = years >= 1 && explained ? xirr([...allFlows, { date: asOf, amount: value }]) : null;
  const totals = { value, cost, gain: value - cost, gainPct: cost ? value / cost - 1 : 0, casValue, sinceCas: value - casValue, sinceCasPct: casValue ? value / casValue - 1 : 0, funds: raw.funds.length, xirr: lifetimeXirr, years };

  // ---- Plan vs execution ---------------------------------------------------
  const planRows: PlanRow[] = [];
  for (const l of raw.planLines) {
    const st = lineStatus(l.planned, l.doneCas, l.approved);
    const bits = [`Planned ${money(l.planned)}`];
    if (l.doneCas > 0.5) bits.push(`${l.side === "SELL" ? "redeemed" : "invested"} ${money(l.doneCas)}${l.doneOn ? ` (latest ${dayMonth(l.doneOn)})` : ""}`);
    if (l.approved > 0.5) bits.push(`${money(l.approved)} confirmed by you, not in a CAS yet`);
    if (st !== "DONE" && l.left > 0.5) bits.push(`${money(l.left)} still to do`);
    planRows.push({ what: `${l.side === "SELL" ? "Exit" : "Buy"} ${shortName(l.name)}`, detail: bits.join("; "), status: st });
  }
  for (const s of raw.sips.filter((x) => x.status !== "CANCELLED")) {
    const what = s.action === "STOP" ? `Stop SIP · ${shortName(s.name)}` : `${s.action === "START" ? "Start" : "Change"} SIP · ${shortName(s.name)} ${money(s.newAmount)}/month`;
    const st: LineStatus = s.status === "COMPLETED" ? "DONE" : s.status === "ADVISED" ? "CONFIRM" : "NOT DONE";
    planRows.push({ what, detail: s.status === "COMPLETED" ? "Seen in your CAS" : s.status === "ADVISED" ? "Advised; not seen in a CAS yet" : "Not advised yet", status: st });
  }
  const own = new Map<string, { amount: number; side: string; last: string }>();
  for (const t of raw.ownTrades.filter((x) => x.date >= windowStart)) {
    const k = `${t.side}|${shortName(t.name)}`;
    const o = own.get(k) ?? { amount: 0, side: t.side, last: t.date };
    o.amount += t.amount;
    o.last = t.date > o.last ? t.date : o.last;
    own.set(k, o);
  }
  for (const [k, o] of own) planRows.push({ what: `${o.side === "BUY" ? "Bought" : "Sold"} on your own · ${k.split("|")[1]}`, detail: `${money(o.amount)}, latest ${dayMonth(o.last)}`, status: "NOT IN PLAN" });
  const counted = planRows.filter((r) => r.status !== "NOT IN PLAN" && r.status !== "NOTE");
  const done = counted.filter((r) => r.status === "DONE").length;

  // ---- Old vs new ----------------------------------------------------------
  let old: QuarterlyReport["old"] = null;
  if (sells.length && rows.length) {
    const byFund = new Map<string, { name: string; units: number; soldFor: number }>();
    for (const t of sells) {
      const o = byFund.get(t.key) ?? { name: nameOf(t.key, t.name), units: 0, soldFor: 0 };
      o.units += unitsOf(t);
      o.soldFor += t.amount;
      byFund.set(t.key, o);
    }
    const oldRows = [...byFund].map(([key, o]) => {
      const nav = navNow(key);
      const worthIfKept = nav ? o.units * nav : o.soldFor;
      return { name: o.name, units: o.units, soldFor: o.soldFor, worthIfKept, ret: o.soldFor ? worthIfKept / o.soldFor - 1 : 0 };
    }).sort((a, b) => b.soldFor - a.soldFor);
    const soldFor = sum(oldRows.map((r) => r.soldFor));
    const worthIfKept = sum(oldRows.map((r) => r.worthIfKept));
    const nr = newRet ?? 0;
    const newWorth = soldFor * (1 + nr);
    const top = rows.slice(0, 5).map((r) => ({ name: r.name, putIn: r.newIn, worth: r.worth, ret: r.ret }));
    const rest = rows.slice(5);
    if (rest.length) top.push({ name: `${rest.length} other fund${rest.length === 1 ? "" : "s"}`, putIn: sum(rest.map((r) => r.newIn)), worth: sum(rest.map((r) => r.worth)), ret: sum(rest.map((r) => r.worth)) / Math.max(1, sum(rest.map((r) => r.newIn))) - 1 });
    old = { rows: oldRows, soldFor, worthIfKept, oldRet: soldFor ? worthIfKept / soldFor - 1 : 0, newRows: top, newWorth, newRet: nr, added: newWorth - worthIfKept, bookIfKept: value - (newWorth - worthIfKept) };
  }

  // ---- Lots, tax, ELSS lock ------------------------------------------------
  const fy = fyOf(asOf);
  const lotsByKey = new Map<string, { cls: TaxClass; lots: ReturnType<typeof fifo>["lots"]; realised: Realised[]; txns: LotTxn[]; opening: number }>();
  const taxKeys = new Set([...raw.funds.map((f) => f.key), ...raw.txns.filter((t) => t.side === "SELL" && t.date >= fy.start).map((t) => t.key)]);
  for (const key of taxKeys) {
    const t = raw.txns.filter((x) => x.key === key && !x.approved);
    const txns: LotTxn[] = t.map((x) => ({ date: x.date, units: x.side === "BUY" ? unitsOf(x) : -unitsOf(x), amount: x.side === "BUY" ? x.amount : -x.amount }));
    const net = sum(txns.map((x) => x.units));
    const held = fundOf.get(key)?.units ?? 0;
    const opening = Math.max(0, held - net);
    const cat = categoryOf(key);
    const nm = fundOf.get(key)?.name ?? soldOf.get(key)?.name ?? t[0]?.name ?? "";
    const cls = taxClassOf(assetClass(cat, nm), cat, nm);
    const r = fifo(txns, cls, opening);
    lotsByKey.set(key, { cls, lots: r.lots, realised: r.realised, txns, opening });
  }
  const realisedAll = [...lotsByKey.values()].flatMap((x) => x.realised.map((r) => ({ ...r, cls: x.cls })));
  const gains = fyGains(realisedAll, fy);
  const unknownLots = [...lotsByKey.values()].some((x) => x.opening > 1e-3);

  // ---- Rebalance (what the plan still has to do) --------------------------
  const open = raw.planLines.filter((l) => l.left > 0.5);
  let rebalance: QuarterlyReport["rebalance"] = null;
  const taxLines: TaxLine[] = [];
  let rebalanceLt = 0;
  let rebalanceSt = 0;
  if (open.length) {
    const sellLines: RebalanceSell[] = open.filter((l) => l.side === "SELL").map((l) => {
      const f = fundOf.get(l.key);
      const units = f?.nav ? l.left / f.nav : null;
      const gain = f && f.value > 0 ? l.left * (1 - f.cost / f.value) : null;
      return { key: l.key, name: nameOf(l.key, l.name), units, value: l.left, gain };
    });
    const redeemed = sum(sellLines.map((s) => s.value));
    let funded = 0;
    const buyLines: RebalanceBuy[] = open.filter((l) => l.side === "BUY").map((l) => {
      funded += l.left;
      return {
        key: l.key, name: nameOf(l.key, l.name), amount: l.left, mode: "Lumpsum",
        fundedBy: funded <= redeemed + 1 ? "Sale proceeds" : funded - l.left < redeemed ? "Sale + fresh money" : "Fresh money",
        why: inputs.buyWhy?.[l.key] ?? l.reason ?? "", lumpsum: inputs.lumpsum?.[l.key] ?? "OPEN", sip: inputs.sipOpen?.[l.key] ?? "OPEN",
      };
    });
    const amcNow = mix(raw.funds.map((f) => ({ name: f.name, category: f.category, amc: f.amc, value: f.value })), raw.planDeltas, "amc", 8);
    const topAmc = amcNow.slices.filter((s) => s.label !== "Other").sort((a, b) => b.nowShare - a.nowShare)[0];
    rebalance = { sells: sellLines, buys: buyLines, redeemed, reinvested: sum(buyLines.map((b) => b.amount)), topAmc: topAmc ? { name: topAmc.label, now: topAmc.nowShare, after: topAmc.afterShare } : null };
    for (const s of sellLines) {
      const f = fundOf.get(s.key);
      const lot = lotsByKey.get(s.key);
      let treatment = "Gain or loss as shown";
      if (lot && s.units) {
        const sim = fifo([...lot.txns, { date: addDaysIso(asOf, 1), units: -s.units, amount: -s.value }], lot.cls, lot.opening).realised.filter((r) => r.date === addDaysIso(asOf, 1));
        const lt = sim.filter((r) => r.term !== "ST").reduce((a, r) => a + r.units, 0);
        const st = sim.filter((r) => r.term === "ST").reduce((a, r) => a + r.units, 0);
        const g = s.gain ?? 0;
        const share = s.units ? lt / s.units : 1;
        if (lot.cls === "EQUITY") { rebalanceLt += g * share; rebalanceSt += g * (1 - share); }
        const loss = g < 0;
        const firstDate = lot.lots[0]?.date;
        treatment = loss
          ? `${st > lt ? "Short" : "Long"}-term loss; offsets gains`
          : lot.cls === "SLAB" ? "Taxed at your slab rate"
          : st < 1e-6 ? `${sim.some((r) => r.term === "UNKNOWN") ? `Bought before ${dayMon(raw.txns.map((t) => t.date).sort()[0] ?? asOf, true)}, so likely long-term` : "Long-term"}${lot.cls === "EQUITY" ? ", inside the ₹1.25L limit if room is left" : ""}`
          : lt < 1e-6 ? `Short-term${lot.cls === "EQUITY" ? " at 20%" : " at slab"}${firstDate ? `; long-term from ${dayMonth(addDaysIso(firstDate, lot.cls === "EQUITY" ? 366 : 731))}` : ""}`
          : "Part long-term, part short-term";
      }
      taxLines.push({ name: s.name, value: s.value, cost: f && f.value > 0 ? s.value * (f.cost / f.value) : null, gain: s.gain, treatment });
    }
  }
  const exemptionLeft = gains.exemptionLeft;
  const estTax = Math.max(0, rebalanceLt - exemptionLeft) * 0.125 + Math.max(0, rebalanceSt) * 0.2;
  const turningLong = [...lotsByKey].flatMap(([key, x]) => (fundOf.has(key) && x.cls === "EQUITY"
    ? lotsTurningLong(x.lots, x.cls, asOf, addDaysIso(asOf, 183)).map((l) => ({ date: l.date, name: nameOf(key, ""), value: l.units * (navNow(key) ?? 0) }))
    : [])).filter((l) => l.value >= 1000).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 6);

  // ---- Fund health ---------------------------------------------------------
  const exiting = new Set((rebalance?.sells ?? []).filter((s) => { const f = fundOf.get(s.key); return f && s.value >= f.value * 0.95; }).map((s) => s.key));
  const health: HealthRow[] = raw.funds.map((f) => {
    const own = inputs.funds?.[f.key];
    const lot = lotsByKey.get(f.key);
    const elss = /elss|tax ?saver/i.test(`${f.category ?? ""} ${f.name}`);
    const youngest = lot?.lots.filter((l) => l.date).map((l) => l.date!).sort().pop();
    const locked = elss && youngest && daysBetween(youngest, asOf) < 3 * 365;
    const status: FundStatus | null = own?.status ?? (exiting.has(f.key) ? "EXIT" : locked ? "LOCKED" : null);
    const why = own?.why ?? (status === "EXIT" ? "Being sold as part of the plan." : status === "LOCKED" && youngest ? `Lock-in: the last units unlock on ${dayMonth(addDaysIso(youngest, 3 * 365 + 1))} ${addDaysIso(youngest, 3 * 365 + 1).slice(0, 4)}.` : "");
    const chosen = f.key in raw.fundIndex;
    return {
      key: f.key, isin: f.isin, index: chosen ? raw.fundIndex[f.key] : defaultIndex(f.category, f.name), indexIsDefault: !chosen, name: shortName(f.name), value: f.value, weight: value ? f.value / value : 0, onCost: f.cost > 0 ? f.value / f.cost - 1 : null,
      sinceCas: f.casValue > 0 ? f.value / f.casValue - 1 : null, status, why,
    };
  }).sort((a, b) => b.value - a.value);
  const unset = health.filter((h) => !h.status);
  if (unset.length) warnings.push(`Fund status not set for ${unset.length} fund(s): ${unset.slice(0, 4).map((h) => h.name).join(", ")}${unset.length > 4 ? "…" : ""}.`);

  // ---- Structure -----------------------------------------------------------
  const nowRows: MixRow[] = raw.funds.map((f) => ({ name: f.name, category: f.category, amc: f.amc, value: f.value }));
  const cap = mix(nowRows, raw.planDeltas, "cap");
  const baseTotal = sum(raw.baseline.map((b) => b.value));
  const beforeOf = (label: CapBucket) => (baseTotal ? sum(raw.baseline.filter((b) => marketCap(b.category, b.name) === label).map((b) => b.value)) / baseTotal : null);
  const structureRows = cap.slices.map((s) => ({ label: s.label as CapBucket, before: beforeOf(s.label as CapBucket), now: s.nowShare, after: s.afterShare }))
    .filter((r) => r.now > 0.0005 || r.after > 0.0005 || (r.before ?? 0) > 0.0005);
  const amc = mix(nowRows, raw.planDeltas, "amc", 5).slices.map((s) => ({ name: s.label, now: s.nowShare, after: s.afterShare }));
  const changes = raw.planDeltas.some((d) => Math.abs(d.value) > 0.5);

  // ---- SIP -----------------------------------------------------------------
  const sipRows: SipRow[] = raw.sips.filter((s) => s.status !== "CANCELLED").map((s) => ({
    id: s.id, name: shortName(s.name), category: shortCategory(s.category, s.name), amount: s.action === "STOP" ? 0 : s.newAmount,
    action: s.action === "STOP" ? "STOP" : s.status === "COMPLETED" ? "RUNNING" : s.action === "START" ? "START" : "CHANGE",
    why: inputs.sipWhy?.[s.id] ?? s.notes ?? "", status: s.status,
  })).sort((a, b) => b.amount - a.amount);
  const fromNext = sum(sipRows.map((r) => r.amount));
  const sipKeys = new Set(raw.sips.filter((s) => s.action !== "STOP" && s.status !== "CANCELLED").map((s) => s.key));
  const buyKeys = new Set((rebalance?.buys ?? []).map((b) => b.key));
  const noNewMoney = inputs.noNewMoney != null
    ? inputs.noNewMoney.split(/[,;]\s*/).map((x) => x.trim()).filter(Boolean)
    : health.filter((h) => !sipKeys.has(h.key) && !buyKeys.has(h.key) && h.status !== "EXIT" && h.weight >= 0.02).map((h) => h.name).slice(0, 6);

  // ---- Market --------------------------------------------------------------
  const move = (code: string, from: string, label: string) => {
    const b = bench.get(code);
    const p = b ? pctChange(raw.navs.get(b.amfi), from, asOf) : null;
    return p == null ? null : { label, pct: p };
  };
  const moves = [
    move("NIFTY50", windowStart, `Nifty 50 · ${dayMonth(windowStart)} – ${dayMonth(asOf)}`),
    daysBetween(casDate, asOf) > 3 ? move("NIFTY50", casDate, `Nifty 50 · since your CAS`) : null,
    move("MIDCAP150", windowStart, `Midcap 150 · ${dayMonth(windowStart)} – ${dayMonth(asOf)}`),
    move("SMALLCAP250", windowStart, `Smallcap 250 · ${dayMonth(windowStart)} – ${dayMonth(asOf)}`),
  ].filter((m): m is { label: string; pct: number } => m !== null);
  const valuations = raw.market.rows.map((r) => ({ ...r, ...valuationRead(r.peNow, r.median) }));

  // ---- Projections ---------------------------------------------------------
  const rates: Rates = inputs.rates ? { bear: inputs.rates.bear / 100, nifty: inputs.rates.nifty / 100, base: inputs.rates.base / 100, moonshot: inputs.rates.moonshot / 100 } : DEFAULT_RATES;
  const pr = (r: number) => PROJECTION_YEARS.map((y) => projectValue(value, fromNext, r, y));
  const projections = {
    start: value, sip: fromNext, rates,
    rows: [
      { label: "Amount invested", key: "invested" as const, values: PROJECTION_YEARS.map((y) => value + fromNext * 12 * y) },
      { label: `Bear ${(rates.bear * 100).toFixed(1).replace(/\.0$/, "")}%`, key: "bear" as const, values: pr(rates.bear) },
      { label: `Nifty 50 ${(rates.nifty * 100).toFixed(1).replace(/\.0$/, "")}%`, key: "nifty" as const, values: pr(rates.nifty) },
      { label: `Base ${(rates.base * 100).toFixed(1).replace(/\.0$/, "")}%`, key: "base" as const, values: pr(rates.base) },
      { label: `Moonshot ${(rates.moonshot * 100).toFixed(1).replace(/\.0$/, "")}%`, key: "moonshot" as const, values: pr(rates.moonshot) },
    ],
    crossesCrore: value > 0 ? yearsToReach(1e7, value, fromNext, rates.base) : null,
  };

  // ---- Texts ---------------------------------------------------------------
  const niftyRet = niftyRep && niftyRep.invested ? niftyRep.value / niftyRep.invested - 1 : null;
  const aheadOfNifty = niftyRep ? worthAll - niftyRep.value : null;
  const niftySinceStart = pctChange(niftySeries, windowStart, asOf);
  const startMonth = monthName(windowStart);
  const nextReview = inputs.nextReview || nextReviewLabel(raw.quarterEnd);

  const headline = inputs.headline || (!deployed
    ? "No new money went in this quarter. Here is how your book stands at the latest NAVs, and what we do next."
    : newRet != null && niftyRet != null && newRet >= 0 && niftyRet < 0
      ? `The market slipped, but the money you put to work since ${startMonth} is still in profit while the Nifty 50 is down.`
      : aheadOfNifty != null && aheadOfNifty >= 0
        ? `The money you put to work since ${startMonth} is ahead of the same rupees in the Nifty 50.`
        : aheadOfNifty != null
          ? `The money you put to work since ${startMonth} is behind the Nifty 50 so far. That is too short a time to judge; we repeat this check every quarter.`
          : `You put ${money(deployed)} of new money to work since ${dayMonth(windowStart)}; on the latest NAVs it is ${pctTxt(newRet)}.`);

  const glance: string[] = inputs.glance ? inputs.glance.split(/\n{2,}|\n/).map((x) => x.trim()).filter(Boolean) : [];
  if (!glance.length) {
    if (deployed) glance.push(`Between ${dayMonth(windowStart)} and ${dayMonth(windowEnd)} you deployed ${money(deployed)} of new money${recycled > 0.5 ? ` (${money(Math.min(recycled, deployed))} recycled from sales, the rest fresh)` : ""}. On the latest NAVs it is worth ${money(worthAll)}.`);
    if (niftyRep && aheadOfNifty != null) glance.push(`The same rupees in a Nifty 50 index fund on the same dates would be worth about ${money(niftyRep.value)}, so you are ${money(Math.abs(aheadOfNifty))} ${aheadOfNifty >= 0 ? "ahead" : "behind"}.`);
    const mover = health.filter((h) => h.sinceCas != null).sort((a, b) => (a.sinceCas! * a.weight) - (b.sinceCas! * b.weight))[0];
    if (mover && mover.sinceCas! < 0 && daysBetween(casDate, asOf) > 3) glance.push(`The largest drag since your ${dayMonth(casDate)} CAS was ${mover.name} (${pctTxt(mover.sinceCas)}), which is ${(mover.weight * 100).toFixed(0)}% of your book.`);
    if (!glance.length) glance.push(`Your book is worth ${money(value)} at the latest NAVs, ${pctTxt(totals.gainPct)} on what it cost.`);
  }

  const sellNames = [...new Set(sells.map((t) => nameOf(t.key, t.name)))];
  const generatedStory = [
    { when: monthName(windowStart).toUpperCase(), title: sells.length ? "The reshuffle" : "The plan", text: sells.length ? `Sold ${money(recycled)} of ${sellNames.slice(0, 2).join(" and ")}${sellNames.length > 2 ? " and others" : ""}; the money went into the new core.` : `${raw.planName ?? "Your plan"} set the direction for this quarter.` },
    { when: `${dayMonth(windowStart)} – ${dayMonth(casDate)}`, title: "Building the new core", text: deployed ? `${money(deployed)} put to work in total: ${money(Math.min(recycled, deployed))} recycled from sales plus ${money(Math.max(0, deployed - recycled))} of fresh money.` : "No new money went in during the quarter." },
    { when: dayMonth(asOf).toUpperCase(), title: "Where it stands", text: `Book ${money(value)}.${newRet != null ? ` New money ${pctTxt(newRet)}` : ""}${niftyRet != null ? ` while the Nifty 50 is ${pctTxt(niftyRet)} on the same dates.` : "."}` },
    { when: "THIS WEEK", title: "The fix", text: rebalance ? `${rebalance.redeemed > 0.5 ? `Redeem ${money(rebalance.redeemed)}` : ""}${rebalance.redeemed > 0.5 && rebalance.reinvested > 0.5 ? " and reinvest " : rebalance.reinvested > 0.5 ? "Invest " : ""}${rebalance.reinvested > 0.5 ? `${money(rebalance.reinvested)} across ${rebalance.buys.length} fund${rebalance.buys.length === 1 ? "" : "s"}` : ""}.${fromNext ? ` ${money(fromNext)} SIP a month.` : ""}` : fromNext ? `Keep the ${money(fromNext)} monthly SIP running.` : "No changes this quarter; hold the book." },
    { when: "AHEAD", title: "Where it heads", text: `${projections.crossesCrore != null && projections.crossesCrore > 0 ? `On our ${(rates.base * 100).toFixed(0)}% base case the book crosses ₹1 Cr in about ${Math.round(projections.crossesCrore)} years${fromNext ? ` with the ${money(fromNext)} SIP` : ""}. ` : ""}Next review: ${nextReview}.` },
  ];
  // Each card the advisor wrote replaces that card; the others stay generated.
  const story = generatedStory.map((g, i) => {
    const own = inputs.story?.[i];
    return own && (own.title || own.text) ? { when: own.when || g.when, title: own.title || g.title, text: own.text || g.text } : g;
  });

  const loose = planRows.filter((r) => r.status === "PARTLY" || r.status === "NOT DONE" || r.status === "CONFIRM");
  const planCallout = inputs.planCallout || (counted.length
    ? loose.length ? `Still open: ${loose.slice(0, 3).map((r) => r.what.replace(/ · /, " ")).join("; ")}${loose.length > 3 ? ` and ${loose.length - 3} more` : ""}.` : "Nothing is left open."
    : "No plan lines in this window.");

  const ahead = compared.filter((r) => (r.ahead ?? 0) >= 0).sort((a, b) => (b.ahead ?? 0) - (a.ahead ?? 0));
  const behind = compared.filter((r) => (r.ahead ?? 0) < 0).sort((a, b) => (a.ahead ?? 0) - (b.ahead ?? 0));
  const winnersNote = inputs.winnersNote || (compared.length
    ? `${ahead.length} of ${compared.length} picks ${ahead.length === 1 ? "was" : "were"} ahead of their own index on the same dates${ahead[0] ? `, led by ${ahead[0].name} (+${money(ahead[0].ahead!)})` : ""}.`
    : "");
  const laggardNote = inputs.laggardNote || (behind[0] ? `${behind[0].name} trailed its index by about ${money(-behind[0].ahead!)} on the same dates. One quarter is not a verdict; we look again at the next review.` : "");

  const oldVsNewNote = inputs.oldVsNewNote || (old
    ? Math.abs(old.added) < 500
      ? "So far the switch is about even: the funds you left and the funds that replaced them are close. A few months is short; we repeat this comparison every quarter."
      : old.added >= 0
      ? `The switch has paid for itself so far. The funds you left are ${pctTxt(old.oldRet)}; the funds that replaced them are ${pctTxt(old.newRet)}. That is ${money(old.added)} more in your account today. A few months is short; we repeat this comparison every quarter.`
      : `So far the funds you left did better: had you kept them you would have ${money(-old.added)} more today. The switch was made for the long run (lower cost, better long-run growth); a few months is too short to judge it, and we repeat this comparison every quarter.`
    : "");

  const biggest = structureRows.slice().sort((a, b) => Math.abs(b.after - b.now) - Math.abs(a.after - a.now))[0];
  const structureNote = inputs.structureNote || (changes && biggest
    ? `After the remaining plan lines, ${biggest.label.toLowerCase()} moves from ${(biggest.now * 100).toFixed(0)}% to ${(biggest.after * 100).toFixed(0)}% of the book.${rebalance?.topAmc ? ` The largest fund house, ${rebalance.topAmc.name}, goes from ${(rebalance.topAmc.now * 100).toFixed(0)}% to ${(rebalance.topAmc.after * 100).toFixed(0)}%.` : ""}`
    : "No changes to the mix this quarter.");

  const sipNote = inputs.sipNote || (fromNext
    ? Math.abs(fromNext - raw.sipMonthly) < Math.max(1000, fromNext * 0.1)
      ? `Same monthly amount, kept automatic. Your SIPs ran at about ${money(raw.sipMonthly)} a month last quarter.`
      : `From next month your SIP is ${money(fromNext)} a month across ${sipRows.filter((r) => r.amount > 0).length} fund${sipRows.filter((r) => r.amount > 0).length === 1 ? "" : "s"}, against about ${money(raw.sipMonthly)} a month last quarter.`
    : "");

  const historyFrom = raw.txns.filter((t) => !t.approved).map((t) => t.date).sort()[0] ?? null;
  const taxNotes = inputs.taxNotes ? inputs.taxNotes.split(/\n+/).map((x) => x.trim()).filter(Boolean) : [];
  if (!taxNotes.length) {
    if (unknownLots && historyFrom) taxNotes.push(`Your CAS history starts on ${dayMonth(historyFrom)} ${historyFrom.slice(0, 4)}, so it does not show when the units held before that were bought. A full-history CAS (from your first investment) lets us pin this year's tax exactly.`);
    taxNotes.push(`This financial year so far: ${money(Math.max(0, gains.equityLt))} of long-term equity gains booked, ${money(gains.exemptionLeft)} of the ₹1.25L tax-free limit left.`);
  }
  taxNotes.push("Estimates only; the final tax depends on lot dates and your other capital gains this year.");

  const ownActions = (inputs.actions ?? []).filter((a) => a.title || a.detail);
  const actions: Action[] = ownActions.length ? ownActions.map((a) => ({ title: a.title, detail: a.detail, when: a.when })) : (() => {
    const a: Action[] = [];
    const sipTodo = sipRows.filter((r) => r.amount > 0 && r.status !== "COMPLETED");
    if (sipTodo.length) a.push({ title: `Register the ${full(sum(sipTodo.map((r) => r.amount)))} SIP`, detail: sipTodo.map((r) => `${r.name} ${full(r.amount)}`).join(", "), when: "This week" });
    if (rebalance?.sells.length) a.push({ title: `Redeem ${rebalance.sells.length === 1 ? rebalance.sells[0].name : `the ${rebalance.sells.length} lines`}`, detail: rebalance.sells.map((s) => `${s.name} (${money(s.value)})`).join(", "), when: "This week" });
    if (rebalance?.buys.length) a.push({ title: rebalance.sells.length ? "Reinvest the proceeds" : "Invest the new money", detail: rebalance.buys.map((b) => `${b.name} ${money(b.amount)}`).join(", "), when: rebalance.sells.length ? "On credit, T+2" : "This week" });
    if (noNewMoney.length) a.push({ title: `No new money into ${noNewMoney.length} fund${noNewMoney.length === 1 ? "" : "s"}`, detail: `${noNewMoney.join(", ")} are held as they are.`, when: "Ongoing" });
    for (const h of health.filter((x) => x.status === "AMBER").slice(0, 2)) a.push({ title: `${h.name} on watch`, detail: h.why || "We look at it again at the next review.", when: `${nextReview} review` });
    if (unknownLots) a.push({ title: "Send a full-history CAS", detail: "Needed to pin down this year's tax and the dates of your older units.", when: "Before the next review" });
    return a.slice(0, 7);
  })();

  // ---- Checks ----------------------------------------------------------------
  if (!reconciles(rows.map((r) => r.newIn), deployed)) errors.push("New money by fund does not add up to the total deployed.");
  if (!reconciles(health.map((h) => h.value), value)) errors.push("Fund values do not add up to the portfolio value.");
  if (!reconciles(sipRows.map((r) => r.amount), fromNext)) errors.push("SIP lines do not add up to the monthly SIP.");
  if (rebalance && rebalance.reinvested > rebalance.redeemed + 1 && !rebalance.buys.some((b) => b.fundedBy !== "Sale proceeds")) errors.push("Reinvested is more than redeemed but no fresh money is shown.");
  const unconfirmed = (rebalance?.buys ?? []).filter((b) => !inputs.lumpsum?.[b.key]);
  if (unconfirmed.length) warnings.push(`Confirm lumpsum / SIP is open for: ${unconfirmed.map((b) => b.name).join(", ")} (shown as OPEN).`);
  if (daysBetween(casDate, asOf) > 45) warnings.push(`The latest confirmed CAS is from ${dayMonth(casDate)} ${casDate.slice(0, 4)}; ask the client for a fresh one before sending.`);

  const report: QuarterlyReport = {
    client: raw.client, quarterEnd: raw.quarterEnd, quarterLabel: quarterLabel(raw.quarterEnd), reviewNo: raw.reviewNo,
    windowStart, windowEnd, asOf, casDate, prepared: raw.today,
    texts: {
      tagline: inputs.tagline || `How your ${raw.planName ? "plan" : "portfolio"} is working, revalued at the latest NAVs, and what we do next.`,
      headline, glance, storySentence: inputs.storySentence ?? "", marketNote: inputs.marketNote || raw.market.note || "",
      planCallout, winnersNote, laggardNote, oldVsNewNote, rebalanceNote: inputs.rebalanceNote ?? "", structureNote, sipNote, taxNotes,
      nextReview, nextReviewNote: inputs.nextReviewNote || "We will repeat this scorecard on the next quarter's CAS: new money vs the Nifty 50 and each fund's own index, sold vs held, and the fund health check.",
    },
    story,
    totals,
    money: { deployed, recycled, fresh: Math.max(0, deployed - recycled), worth: worthAll, ret: newRet, niftyWorth: niftyRep?.value ?? null, niftyRet, aheadOfNifty, niftySinceStart, indexAsOf },
    health,
    score: { rows, total: { newIn: deployed, worth: worthAll, ret: newRet ?? 0 }, ahead: ahead.length, compared: compared.length },
    plan: { rows: planRows, done, total: counted.length },
    old,
    rebalance,
    structure: { rows: structureRows, amc, changes },
    sip: { rows: sipRows, fromNext, lastQuarter: raw.sipMonthly, noNewMoney },
    market: { moves, valuations, asOf: raw.market.asOf ?? null },
    tax: { fy: fy.label, gains, lines: taxLines, estTax, exitLoad: inputs.exitLoad ?? 0, historyFrom, unknownLots, turningLong },
    projections,
    actions,
    checks: { errors, warnings },
  };
  const forbidden = scanForbidden(allText(report), raw.otherClientNames);
  for (const f of forbidden) errors.push(`The text contains ${f}; remove it before downloading.`);
  return report;
}

function shortCategory(category: string | null, name: string): string {
  const cap = marketCap(category, name);
  if (cap !== "Other" && cap !== "Flexi / multi" && cap !== "Sectoral") return cap;
  const tail = (category ?? "").split(/\s+-\s+/).slice(1).join(" - ").replace(/\s*fund$/i, "").trim();
  return tail || cap;
}

/** Every piece of text that goes into the PDF (for the forbidden-terms scan). */
export function allText(r: QuarterlyReport): string {
  const t = r.texts;
  return [
    t.tagline, t.headline, ...t.glance, t.storySentence, t.marketNote, t.planCallout, t.winnersNote, t.laggardNote, t.oldVsNewNote,
    t.rebalanceNote, t.structureNote, t.sipNote, ...t.taxNotes, t.nextReview, t.nextReviewNote,
    ...r.story.flatMap((s) => [s.when, s.title, s.text]),
    ...r.health.map((h) => h.why), ...r.sip.rows.map((s) => s.why), ...(r.rebalance?.buys ?? []).map((b) => b.why),
    ...r.actions.flatMap((a) => [a.title, a.detail, a.when]), ...r.plan.rows.map((p) => `${p.what} ${p.detail}`),
  ].join("\n");
}
