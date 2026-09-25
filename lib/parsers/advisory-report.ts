/**
 * Deterministic parser for the Univest "Portfolio Rebalancing & Execution
 * Report" (the paid advisory report). Input: text lines from lib/pdf/text.ts.
 *
 * Reads the SELL table, the BUY table, the SIP table (+ its routing panel) and
 * the fund-wise review (one verdict per holding). Rows are recognised by the
 * SHAPE of their cells (folio, ₹ amount, "—", change word), never by fixed
 * column positions, because long text wraps into extra cells in the PDF.
 *
 * Every table is then cross-checked against an independent part of the same
 * report (printed totals, headline figures, the review verdicts, the SIP
 * routing panel). Anything that does not reconcile is reported in `problems`.
 * Callers must treat ANY problem as blocking: nothing is guessed.
 */
import { parseNumber, toIsoDate } from "./cas";
import { nameSimilarity } from "@/lib/domain/securities";

export type ReportSellAction = "SELL" | "SWITCH" | "RETAIN" | "UNKNOWN";

export interface ReportSellRow {
  fund: string;
  folio: string | null;
  actionText: string;
  action: ReportSellAction;
  /** Part of the holding only ("Trim ₹5L", "partial"), not a full exit. */
  partial: boolean;
  value: number;
  /** One row covering several folios of the same fund ("x2 folios"). */
  folioCount?: number;
}
export interface ReportBuyRow {
  fund: string;
  amc: string | null;
  category: string | null;
  planType: "DIRECT" | "REGULAR" | null;
  amount: number;
  mode: string | null;
  fundedBy: string | null;
  /** "new" fund or "top-up" of a fund already held (from the meta line). */
  kind: "NEW" | "TOP_UP" | null;
}
export interface ReportSipRow {
  fund: string;
  planType: "DIRECT" | "REGULAR" | null;
  current: number | null;
  next: number | null;
  change: "START" | "STOP" | "CHANGE";
  changeText: string;
  frequencyNote: string | null;
  /** Current amount marked with * (footnote: not in the current total). */
  excludedFromTotal: boolean;
}
export type ReviewVerdict = "EXIT" | "TRIM" | "HOLD" | "ADD" | "SWITCH";
export interface ReportReviewRow {
  fund: string;
  value: number;
  verdictText: string;
  verdict: ReviewVerdict | null;
  amount: number | null;
}

export interface AdvisoryReportParse {
  template: "UNIVEST_REBALANCING_V1" | "GENERIC_TABLES";
  clientName: string | null;
  riskProfile: string | null;
  goal: string | null;
  casPeriod: { from: string | null; to: string | null };
  valuationDate: string | null;
  preparedDate: string | null;
  currentValue: number | null;
  sells: ReportSellRow[];
  sellTotal: number | null;
  buys: ReportBuyRow[];
  buyTotal: number | null;
  sips: ReportSipRow[];
  sipTotals: { current: number | null; next: number | null };
  sipRouting: { fund: string; amount: number }[];
  review: ReportReviewRow[];
  /** Funds the report keeps / defers with their value (not sold now). */
  holds: { fund: string; folio: string | null; folioCount: number; planType: "DIRECT" | "REGULAR" | null; value: number; note: string }[];
  /** Funds named in a fund list / status table (proves the report covers them). */
  mentioned: { fund: string; planType: "DIRECT" | "REGULAR" | null; folio: string | null; folioCount: number }[];
  deploymentNotes: string[];
  /** Anything that does not reconcile. Callers must block on any entry. */
  problems: string[];
  /** @deprecated alias of `problems` */
  warnings: string[];
}

export class ReportParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportParseError";
  }
}

// ---------------------------------------------------------------------------
// Cell helpers
// ---------------------------------------------------------------------------
const cellsOf = (l: string) => l.split(" | ").map((c) => c.trim());
const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/** "₹17,29,977" / "₹5.00L" / "₹1.2 Cr" / "16,500" → rupees, with the precision the text allows. */
export function parseAmount(s: string | null | undefined): { value: number; precision: number } | null {
  if (!s) return null;
  const t = s.replace(/[₹≈\s*]/g, "").replace(/[−–]/g, "-");
  const m = /^(-?[\d,]*\.?\d+)(L|Lakh|Lakhs|Cr|Crore|Crores|k)?$/i.exec(t);
  if (!m) return null;
  const n = parseNumber(m[1]);
  if (n === null) return null;
  const unit = (m[2] ?? "").toLowerCase();
  const mult = unit.startsWith("l") ? 1e5 : unit.startsWith("c") ? 1e7 : unit === "k" ? 1e3 : 1;
  const decimals = (m[1].split(".")[1] ?? "").length;
  return { value: Math.round(n * mult * 100) / 100, precision: mult === 1 ? 1 : (mult / 10 ** decimals) / 2 };
}
const money = (s: string | null | undefined) => parseAmount(s)?.value ?? null;
const isRupeeCell = (c: string) => /^₹\s?[\d,]+(\.\d+)?$/.test(c);
const isDash = (c: string) => /^[—–-]$/.test(c.trim());
const isSipNumber = (c: string) => isDash(c) || /^[\d,]+(\.\d+)?\*?$/.test(c);
const isFolio = (c: string) => /^[0-9A-Z]{4,}(\s*\/\s*[0-9A-Z]+)?$/.test(c);

function planTypeOf(s: string): "DIRECT" | "REGULAR" | null {
  if (/\bdirect\b|\(dir\)/i.test(s)) return "DIRECT";
  if (/\bregular\b|\(reg\)/i.test(s)) return "REGULAR";
  return null;
}

export function mapSellAction(text: string): ReportSellAction {
  const t = text.toLowerCase();
  if (/switch/.test(t)) return "SWITCH";
  if (/full exit|exit|redeem|sell|trim|partial|reduce|withdraw/.test(t)) return "SELL";
  if (/retain|hold|keep|continue/.test(t)) return "RETAIN";
  return "UNKNOWN";
}

export function mapRisk(text: string | null): string | null {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/moderately aggressive|moderately high/.test(t)) return "MODERATELY_AGGRESSIVE";
  if (/moderately conservative|moderately low/.test(t)) return "MODERATELY_CONSERVATIVE";
  if (/aggressive|high risk|very high/.test(t)) return "AGGRESSIVE";
  if (/conservative|low risk/.test(t)) return "CONSERVATIVE";
  if (/moderate/.test(t)) return "MODERATE";
  return null;
}

const VERDICT_RE = /^(EXIT|SELL|HOLD|KEEP|RETAIN|TRIM|REDUCE|ADD|TOP[- ]?UP|BUY|SWITCH)\b/;
function mapVerdict(text: string): { verdict: ReviewVerdict | null; amount: number | null } {
  const word = VERDICT_RE.exec(text)?.[1] ?? "";
  const amount = money(/₹\s?[\d,.]+\s*(L|Cr|k)?/i.exec(text)?.[0]);
  if (/^(EXIT|SELL)$/.test(word)) return { verdict: "EXIT", amount: null };
  if (/^(HOLD|KEEP|RETAIN)$/.test(word)) return { verdict: "HOLD", amount: null };
  if (/^(TRIM|REDUCE)$/.test(word)) return { verdict: "TRIM", amount };
  if (/^(ADD|TOP[- ]?UP|BUY)$/.test(word)) return { verdict: "ADD", amount };
  if (word === "SWITCH") return { verdict: "SWITCH", amount: null };
  return { verdict: null, amount: null };
}

/** Header line whose cells contain all the given labels (in any column). */
function findHeader(lines: string[], ...labels: string[]): number {
  return lines.findIndex((l) => {
    const c = cellsOf(l).map((x) => x.toUpperCase());
    return c[0] === labels[0] && labels.slice(1).every((h) => c.some((x) => x.startsWith(h)));
  });
}
const isPageEnd = (l: string) => /^UNIVEST WEALTH\b/.test(l) || /^Univest Wealth Portfolio Report/i.test(l);

// ---------------------------------------------------------------------------
/** The first Univest layout ("Portfolio Rebalancing & Execution Report"). */
export function isUnivestV1(rawLines: string[]): boolean {
  const text = rawLines.join("\n");
  return /UNIVEST WEALTH/i.test(text) && /LUMPSUM ACTION PLAN|WHAT WE SELL|FUND \| FOLIO \| ACTION/i.test(text.replace(/(\S) (?=\S( |$))/g, "$1"));
}

export function parseAdvisoryReportLines(rawLines: string[]): AdvisoryReportParse {
  const lines = rawLines.map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => l && !l.startsWith("@@PAGE_BREAK"));
  const text = lines.join("\n");
  if (!isUnivestV1(lines)) {
    throw new ReportParseError("This does not look like a Univest Portfolio Rebalancing & Execution Report.");
  }
  const problems: string[] = [];

  const clientName = /Portfolio Report\s*[—-]\s*(.+?)\s*[—-]\s*Page \d+/i.exec(text)?.[1]?.trim() ?? null;
  if (!clientName) problems.push("Client name not found in the report footer.");

  const period = /CAS period (\d{2}-[A-Za-z]{3}-\d{4}) to (\d{2}-[A-Za-z]{3}-\d{4})/i.exec(text);
  const valuation = /Valuation date (\d{2}-[A-Za-z]{3}-\d{4})/i.exec(text);
  const prepared = /Prepared (\d{2}-[A-Za-z]{3}-\d{4})/i.exec(text);

  const profileLine = lines.find((l) => /\brisk\s*·/i.test(l)) ?? null;
  const profileParts = profileLine ? profileLine.split("·").map((s) => s.trim()) : [];
  const riskProfile = mapRisk(profileParts.find((p) => /risk/i.test(p)) ?? null);
  const goal = profileParts.filter((p) => !/risk/i.test(p)).join(" · ") || null;

  const cvIdx = lines.findIndex((l) => /CURRENT VALUE \(/i.test(l));
  let currentValue: number | null = null;
  if (cvIdx > 0) {
    const amounts = cellsOf(lines[cvIdx - 1]).map((c) => (/%$/.test(c) ? null : money(c)));
    const pos = cellsOf(lines[cvIdx]).findIndex((l) => /CURRENT VALUE/i.test(l));
    currentValue = amounts[pos] ?? null;
  }

  // ---------------- SELL table ----------------
  // Row: FUND | FOLIO | action text (may wrap into several cells) | ₹VALUE | …
  const sells: ReportSellRow[] = [];
  let sellTotal: number | null = null;
  const sh = findHeader(lines, "FUND", "FOLIO", "ACTION", "VALUE");
  if (sh < 0) problems.push("Sell table (FUND | FOLIO | ACTION | VALUE) not found.");
  else {
    for (let i = sh + 1; i < lines.length; i++) {
      const c = cellsOf(lines[i]);
      if (/^Total to be redeemed/i.test(c[0])) {
        sellTotal = money(c.find((x) => x.includes("₹")) ?? c[1]);
        break;
      }
      if (isPageEnd(lines[i])) break;
      if (c.length >= 3 && isFolio(c[1])) {
        const vIdx = c.findIndex((x, j) => j >= 2 && isRupeeCell(x));
        if (vIdx < 0) {
          problems.push(`Sell row "${c[0]}": the ₹ value could not be found.`);
          continue;
        }
        const actionText = c.slice(2, vIdx).join(" ").trim();
        const action = mapSellAction(actionText);
        if (action === "UNKNOWN" || action === "RETAIN") problems.push(`Sell row "${c[0]}": unclear action "${actionText}".`);
        sells.push({
          fund: c[0],
          folio: c[1].replace(/\s+/g, ""),
          actionText,
          action,
          partial: /trim|partial|reduce|part of|₹/i.test(actionText) && !/full/i.test(actionText),
          value: money(c[vIdx])!,
        });
      } else if (sells.length && c.length === 1 && !/^(Why|Values|Total|All|Later)/i.test(c[0]) && c[0].length < 60 && !c[0].includes("₹")) {
        sells[sells.length - 1].fund += ` ${c[0]}`; // wrapped fund name
      }
    }
    if (sellTotal === null) problems.push("Sell table total row (Total to be redeemed) not found.");
  }

  // ---------------- BUY table ----------------
  const buys: ReportBuyRow[] = [];
  let buyTotal: number | null = null;
  const bh = findHeader(lines, "FUND", "AMOUNT", "MODE");
  if (bh < 0) problems.push("Buy table (FUND | AMOUNT | MODE) not found.");
  else {
    for (let i = bh + 1; i < lines.length; i++) {
      const c = cellsOf(lines[i]);
      if (/^Total buy/i.test(c[0])) {
        buyTotal = money(c[1]);
        break;
      }
      if (isPageEnd(lines[i])) break;
      if (c.length >= 3 && isRupeeCell(c[1]) && !c[0].includes("·")) {
        const next = cellsOf(lines[i + 1] ?? "");
        const meta = next[0]?.includes("·") ? next[0].split("·").map((s) => s.trim()) : [];
        const tail = meta.slice(2).join(" ");
        buys.push({
          fund: c[0],
          amc: meta[0] ?? null,
          category: meta[1] ?? null,
          planType: planTypeOf(tail) ?? planTypeOf(c[0]),
          amount: money(c[1])!,
          mode: c[2] ?? null,
          fundedBy: c[3] ?? null,
          kind: /top[- ]?up/i.test(tail) ? "TOP_UP" : /\bnew\b/i.test(tail) ? "NEW" : null,
        });
      }
    }
    if (buyTotal === null) problems.push("Buy table total row (Total buy) not found.");
  }

  // ---------------- SIP table (+ routing panel printed beside it) ----------------
  // Row: FUND | current (number, "—", or "20,000*") | new | change word/number [| routing fund | ₹amount]
  // Routing-panel-only lines: "Motilal Oswal Large & Midcap | ₹18,000".
  const sips: ReportSipRow[] = [];
  const sipRouting: { fund: string; amount: number }[] = [];
  let sipCurrent: number | null = null;
  let sipNext: number | null = null;
  const ph = findHeader(lines, "FUND", "CURRENT", "NEW", "CHANGE");
  if (ph >= 0) {
    for (let i = ph + 1; i < lines.length; i++) {
      const c = cellsOf(lines[i]);
      if (/^Total monthly SIP/i.test(c[0])) {
        sipCurrent = money(c[1]);
        sipNext = money(c[2]);
        break;
      }
      if (isPageEnd(lines[i])) break;
      // routing pair at the end of the line
      const last = c[c.length - 1];
      if (c.length >= 2 && isRupeeCell(last) && !isRupeeCell(c[c.length - 2])) {
        sipRouting.push({ fund: c[c.length - 2], amount: money(last)! });
      }
      if (c.length < 4 || !isSipNumber(c[1]) || !isSipNumber(c[2])) continue;
      const changeText = c[3];
      if (!/^(new|start|stop|increase|decrease|change|continue|no change|same|[+−–-]?\s?[\d,]+)$/i.test(changeText)) continue;
      const [fundName, ...rest] = c[0].split("·").map((s) => s.trim());
      const current = isDash(c[1]) ? null : money(c[1]);
      const next = isDash(c[2]) ? null : money(c[2]);
      let change: ReportSipRow["change"];
      if (current === null && next) change = "START";
      else if (next === null && current) change = "STOP";
      else if (current !== null && next !== null) {
        if (current === next) continue; // unchanged SIP: nothing to do
        change = "CHANGE";
      } else {
        problems.push(`SIP row "${c[0]}": amounts unreadable.`);
        continue;
      }
      const said = /^(new|start)/i.test(changeText) ? "START" : /^stop/i.test(changeText) ? "STOP" : "CHANGE";
      if (said !== change) problems.push(`SIP row "${fundName}": says "${changeText}" but the amounts (${c[1]} → ${c[2]}) mean ${change}.`);
      sips.push({
        fund: fundName,
        planType: planTypeOf(c[0]),
        current,
        next,
        change,
        changeText,
        frequencyNote: rest.join(" · ") || null,
        excludedFromTotal: /\*$/.test(c[1]),
      });
    }
    if (sipNext === null) problems.push("SIP table total row (Total monthly SIP) not found.");
  } else if (/SIP PLAN|S I P P L A N/i.test(text)) {
    problems.push("The report has a SIP plan page but its table (FUND | CURRENT | NEW | CHANGE) was not found.");
  }

  // ---------------- Fund-wise review: one verdict per holding ----------------
  const review: ReportReviewRow[] = [];
  const rh = findHeader(lines, "FUND", "VALUE", "VERDICT");
  if (rh >= 0) {
    const vCol = cellsOf(lines[rh]).findIndex((x) => x.toUpperCase().startsWith("VERDICT"));
    for (let i = rh + 1; i < lines.length; i++) {
      if (isPageEnd(lines[i]) || /^1Y\b/.test(lines[i])) break;
      const c = cellsOf(lines[i]);
      if (c.length < 3 || !isRupeeCell(c[1])) continue;
      const vText = VERDICT_RE.test(c[vCol] ?? "") ? c[vCol] : c.find((x, j) => j > 1 && VERDICT_RE.test(x));
      if (!vText) {
        problems.push(`Fund-wise review: no verdict found for "${c[0]}".`);
        continue;
      }
      const v = mapVerdict(vText);
      if (!v.verdict) problems.push(`Fund-wise review: unknown verdict "${vText}" for ${c[0]}.`);
      review.push({ fund: c[0], value: money(c[1])!, verdictText: vText, verdict: v.verdict, amount: v.amount });
    }
  } else {
    problems.push("Fund-wise review table (FUND | VALUE | … | VERDICT) not found, so the sell list cannot be double-checked.");
  }

  // Deployment plan (informational, stored in plan notes).
  const deploymentNotes: string[] = [];
  const dh = lines.findIndex((l) => /^What happens, day by day/i.test(l));
  if (dh >= 0) {
    for (let i = dh + 1; i < Math.min(lines.length, dh + 40); i++) {
      if (isPageEnd(lines[i])) break;
      deploymentNotes.push(lines[i].replace(/ \| /g, " — "));
    }
  }

  // ---------------- Cross-checks (independent sources inside the report) ----------------
  const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;
  const close = (a: number, b: number, precision = 1) => Math.abs(a - b) <= Math.max(2, precision, Math.abs(b) * 0.0005);

  // 1) Table rows vs printed totals and headline figures.
  const sellSum = sum(sells.map((s) => s.value));
  if (sellTotal !== null && !close(sellSum, sellTotal)) problems.push(`Sell rows add up to ${inr(sellSum)} but the report total is ${inr(sellTotal)}.`);
  const buySum = sum(buys.map((b) => b.amount));
  if (buyTotal !== null && !close(buySum, buyTotal)) problems.push(`Buy rows add up to ${inr(buySum)} but the report total is ${inr(buyTotal)}.`);
  const headline = (re: RegExp) => {
    const l = lines.find((x) => re.test(x));
    const cell = l ? cellsOf(l).find((x) => x.includes("₹")) : undefined;
    return cell ? parseAmount(/₹\s?[\d,.]+\s*(L|Cr)?/i.exec(cell)?.[0]) : null;
  };
  const sellHead = headline(/^What we sell\b/i);
  if (sellHead && sellTotal !== null && !close(sellHead.value, sellTotal, sellHead.precision)) {
    problems.push(`The sell page headline says ${inr(sellHead.value)} but the sell table total is ${inr(sellTotal)}.`);
  }
  const buyHead = headline(/^What we buy\b/i);
  if (buyHead && buyTotal !== null && !close(buyHead.value, buyTotal, buyHead.precision)) {
    problems.push(`The buy page headline says ${inr(buyHead.value)} but the buy table total is ${inr(buyTotal)}.`);
  }

  // 2) SIP rows vs totals and the routing panel.
  if (sipNext !== null) {
    const nextSum = sum(sips.filter((s) => s.change !== "STOP").map((s) => s.next ?? 0));
    if (!close(nextSum, sipNext)) problems.push(`New SIP rows add up to ${inr(nextSum)}/month but the report total is ${inr(sipNext)}.`);
  }
  if (sipCurrent !== null) {
    const counted = sum(sips.filter((s) => !s.excludedFromTotal).map((s) => s.current ?? 0));
    const all = sum(sips.map((s) => s.current ?? 0));
    if (!close(counted, sipCurrent) && !close(all, sipCurrent)) {
      problems.push(`Current SIP rows add up to ${inr(counted)}/month but the report total is ${inr(sipCurrent)}.`);
    }
  }
  if (sipRouting.length) {
    const newRows = sips.filter((s) => s.next);
    for (const r of sipRouting) {
      const hit = newRows.find((s) => nameSimilarity(s.fund, r.fund) >= 0.7 && close(s.next!, r.amount));
      if (!hit) problems.push(`SIP routing panel lists ${r.fund} ${inr(r.amount)}/month, but no SIP row matches it.`);
    }
    if (sipNext !== null && !close(sum(sipRouting.map((r) => r.amount)), sipNext)) {
      problems.push(`SIP routing panel adds up to ${inr(sum(sipRouting.map((r) => r.amount)))} but the SIP total is ${inr(sipNext)}.`);
    }
  }

  // 3) Sell list vs fund-wise review verdicts (each holding has exactly one verdict).
  if (review.length) {
    const claimed = new Set<ReportSellRow>();
    const bestSell = (r: ReportReviewRow) =>
      sells
        .filter((s) => !claimed.has(s) && nameSimilarity(s.fund, r.fund) >= 0.7)
        .sort((a, b) => nameSimilarity(b.fund, r.fund) - nameSimilarity(a.fund, r.fund) || Math.abs(a.value - r.value) - Math.abs(b.value - r.value))[0];
    for (const r of review) {
      if (r.verdict === "EXIT" || r.verdict === "SWITCH") {
        const s = sells.filter((x) => !claimed.has(x) && nameSimilarity(x.fund, r.fund) >= 0.7).find((x) => close(x.value, r.value)) ?? bestSell(r);
        if (!s) problems.push(`Review says ${r.verdictText} for ${r.fund} (${inr(r.value)}) but the sell table has no row for it.`);
        else {
          claimed.add(s);
          if (!close(s.value, r.value)) problems.push(`${r.fund}: review value ${inr(r.value)} but sell row value ${inr(s.value)} (a full exit should sell everything).`);
          if (r.verdict === "SWITCH" && s.action !== "SWITCH") problems.push(`${r.fund}: review says switch but the sell row says "${s.actionText}".`);
        }
      } else if (r.verdict === "TRIM") {
        const s = bestSell(r);
        if (!s) problems.push(`Review says ${r.verdictText} for ${r.fund} but the sell table has no row for it.`);
        else {
          claimed.add(s);
          const p = parseAmount(/₹\s?[\d,.]+\s*(L|Cr|k)?/i.exec(r.verdictText)?.[0]);
          if (p && !close(s.value, p.value, p.precision)) problems.push(`${r.fund}: review says trim ${inr(p.value)} but the sell row is ${inr(s.value)}.`);
          if (s.value >= r.value) problems.push(`${r.fund}: a trim sells ${inr(s.value)}, which is not less than the holding (${inr(r.value)}).`);
          s.partial = true;
        }
      } else if (r.verdict === "HOLD") {
        const s = sells.find((x) => !claimed.has(x) && nameSimilarity(x.fund, r.fund) >= 0.85 && close(x.value, r.value));
        if (s) problems.push(`Review says HOLD for ${r.fund} but the sell table sells it.`);
      } else if (r.verdict === "ADD") {
        const b = buys.find((x) => nameSimilarity(x.fund, r.fund) >= 0.7);
        if (!b) problems.push(`Review says ${r.verdictText} for ${r.fund} but the buy table has no row for it.`);
        else if (r.amount !== null && !close(b.amount, r.amount)) problems.push(`${r.fund}: review says add ${inr(r.amount)} but the buy row is ${inr(b.amount)}.`);
      }
    }
    for (const s of sells) {
      if (!claimed.has(s)) problems.push(`Sell row "${s.fund}" (folio ${s.folio}) has no EXIT/TRIM/SWITCH verdict in the fund-wise review.`);
    }
    if (currentValue !== null) {
      const reviewSum = sum(review.map((r) => r.value));
      if (!close(reviewSum, currentValue, Math.max(2, review.length))) {
        problems.push(`Fund-wise review values add up to ${inr(reviewSum)} but the report's current value is ${inr(currentValue)}: a holding may be missing.`);
      }
    }
  }

  if (sells.length === 0 && buys.length === 0 && sips.length === 0) {
    throw new ReportParseError("No sell, buy or SIP rows could be read from this report.");
  }

  return {
    template: "UNIVEST_REBALANCING_V1",
    clientName,
    riskProfile,
    goal,
    casPeriod: { from: period ? toIsoDate(period[1]) : null, to: period ? toIsoDate(period[2]) : null },
    valuationDate: valuation ? toIsoDate(valuation[1]) : null,
    preparedDate: prepared ? toIsoDate(prepared[1]) : null,
    currentValue,
    sells,
    sellTotal,
    buys,
    buyTotal,
    sips,
    sipTotals: { current: sipCurrent, next: sipNext },
    sipRouting,
    review,
    holds: [],
    mentioned: [],
    deploymentNotes,
    problems,
    warnings: problems,
  };
}

/** Loose person-name comparison (report name vs CAS holder name). */
export function sameInvestor(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const tok = (s: string) => new Set(s.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((t) => t.length > 1));
  const ta = tok(a);
  const tb = tok(b);
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return common >= Math.min(2, ta.size, tb.size);
}
