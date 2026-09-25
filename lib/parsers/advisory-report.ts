/**
 * Deterministic parser for the Univest "Portfolio Rebalancing & Execution
 * Report" (the paid advisory report). Input: text lines from lib/pdf/text.ts.
 *
 * Reads: client name, risk/goal, CAS period + valuation date, the SELL table
 * (fund | folio | action | value), the BUY table (fund | amount | mode) and the
 * SIP table (fund | current | new | change), and cross-checks every table total.
 * Pure function, unit-tested. Unknown wording becomes a warning, never a guess.
 */
import { parseNumber, toIsoDate } from "./cas";

export type ReportSellAction = "SELL" | "SWITCH" | "RETAIN" | "UNKNOWN";

export interface ReportSellRow {
  fund: string;
  folio: string | null;
  actionText: string;
  action: ReportSellAction;
  value: number;
}
export interface ReportBuyRow {
  fund: string;
  amc: string | null;
  category: string | null;
  planType: "DIRECT" | "REGULAR" | null;
  amount: number;
  mode: string | null;
  fundedBy: string | null;
}
export interface ReportSipRow {
  fund: string;
  planType: "DIRECT" | "REGULAR" | null;
  current: number | null;
  next: number | null;
  change: "START" | "STOP" | "CHANGE";
  changeText: string;
  frequencyNote: string | null;
}

export interface AdvisoryReportParse {
  template: "UNIVEST_REBALANCING_V1";
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
  deploymentNotes: string[];
  warnings: string[];
}

export class ReportParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportParseError";
  }
}

const rupees = (s: string | undefined | null) => parseNumber((s ?? "").replace(/[₹≈\s]/g, "").replace(/−/g, "-"));
const cellsOf = (l: string) => l.split(" | ").map((c) => c.trim());

function planTypeOf(s: string): "DIRECT" | "REGULAR" | null {
  if (/\bdirect\b|\(dir\)/i.test(s)) return "DIRECT";
  if (/\bregular\b|\(reg\)/i.test(s)) return "REGULAR";
  return null;
}

export function mapSellAction(text: string): ReportSellAction {
  const t = text.toLowerCase();
  if (/switch/.test(t)) return "SWITCH";
  if (/full exit|exit|redeem|sell/.test(t)) return "SELL";
  if (/retain|hold|keep|continue/.test(t)) return "RETAIN";
  return "UNKNOWN";
}

function mapRisk(text: string | null): string | null {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/moderately aggressive|moderately high/.test(t)) return "MODERATELY_AGGRESSIVE";
  if (/moderately conservative|moderately low/.test(t)) return "MODERATELY_CONSERVATIVE";
  if (/aggressive|high risk|very high/.test(t)) return "AGGRESSIVE";
  if (/conservative|low risk/.test(t)) return "CONSERVATIVE";
  if (/moderate/.test(t)) return "MODERATE";
  return null;
}

/** Index of the first line whose cells start with the given header cells. */
function findHeader(lines: string[], ...head: string[]): number {
  return lines.findIndex((l) => {
    const c = cellsOf(l).map((x) => x.toUpperCase());
    return head.every((h, i) => c[i]?.startsWith(h));
  });
}

export function parseAdvisoryReportLines(rawLines: string[]): AdvisoryReportParse {
  const lines = rawLines.map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => l && !l.startsWith("@@PAGE_BREAK"));
  const text = lines.join("\n");
  if (!/UNIVEST WEALTH/i.test(text) || !/LUMPSUM ACTION PLAN|WHAT WE SELL|FUND \| FOLIO \| ACTION/i.test(text.replace(/(\S) (?=\S( |$))/g, "$1"))) {
    throw new ReportParseError("This does not look like a Univest Portfolio Rebalancing & Execution Report.");
  }
  const warnings: string[] = [];

  // Client name: from the running footer "Portfolio Report — <Name> — Page n".
  const clientName = /Portfolio Report\s*[—-]\s*(.+?)\s*[—-]\s*Page \d+/i.exec(text)?.[1]?.trim() ?? null;
  if (!clientName) warnings.push("Client name not found in the report footer.");

  const period = /CAS period (\d{2}-[A-Za-z]{3}-\d{4}) to (\d{2}-[A-Za-z]{3}-\d{4})/i.exec(text);
  const valuation = /Valuation date (\d{2}-[A-Za-z]{3}-\d{4})/i.exec(text);
  const prepared = /Prepared (\d{2}-[A-Za-z]{3}-\d{4})/i.exec(text);

  // Page-1 profile line: "Moderate risk · Wealth creation · ..."
  const profileLine = lines.find((l) => /\brisk\s*·/i.test(l)) ?? null;
  const profileParts = profileLine ? profileLine.split("·").map((s) => s.trim()) : [];
  const riskProfile = mapRisk(profileParts.find((p) => /risk/i.test(p)) ?? null);
  const goal = profileParts.filter((p) => !/risk/i.test(p)).join(" · ") || null;

  const cvIdx = lines.findIndex((l) => /CURRENT VALUE \(/i.test(l));
  let currentValue: number | null = null;
  if (cvIdx > 0) {
    const amounts = cellsOf(lines[cvIdx - 1])
      .map((c) => c.replace(/₹/g, "").trim())
      .filter((c) => /^[\d,]+(\.\d+)?%?$/.test(c))
      .map((c) => (c.endsWith("%") ? null : rupees(c)));
    const labels = cellsOf(lines[cvIdx]);
    const pos = labels.findIndex((l) => /CURRENT VALUE/i.test(l));
    currentValue = amounts[pos] ?? null;
  }

  // ---------------- SELL table ----------------
  const sells: ReportSellRow[] = [];
  let sellTotal: number | null = null;
  const sh = findHeader(lines, "FUND", "FOLIO", "ACTION", "VALUE");
  if (sh < 0) warnings.push("Sell table (FUND | FOLIO | ACTION | VALUE) not found.");
  else {
    for (let i = sh + 1; i < lines.length; i++) {
      const c = cellsOf(lines[i]);
      if (/^Total to be redeemed/i.test(c[0])) {
        sellTotal = rupees(c.find((x) => x.includes("₹")) ?? c[1]);
        break;
      }
      if (c.length >= 4 && c[3].includes("₹")) {
        const value = rupees(c[3]);
        if (value === null) {
          warnings.push(`Sell row "${c[0]}": value unreadable.`);
          continue;
        }
        const action = mapSellAction(c[2]);
        if (action === "UNKNOWN") warnings.push(`Sell row "${c[0]}": unknown action "${c[2]}".`);
        sells.push({ fund: c[0], folio: c[1] ? c[1].replace(/\s+/g, "") : null, actionText: c[2], action, value });
      } else if (sells.length && c.length === 1 && !/^(Why|Values|Total|All)/i.test(c[0]) && c[0].length < 60 && !c[0].includes("₹")) {
        // wrapped fund name
        sells[sells.length - 1].fund += ` ${c[0]}`;
      }
      if (/^UNIVEST WEALTH/i.test(c[0])) break;
    }
    if (sellTotal === null) warnings.push("Sell table total row not found.");
  }

  // ---------------- BUY table ----------------
  const buys: ReportBuyRow[] = [];
  let buyTotal: number | null = null;
  const bh = findHeader(lines, "FUND", "AMOUNT", "MODE");
  if (bh < 0) warnings.push("Buy table (FUND | AMOUNT | MODE) not found.");
  else {
    for (let i = bh + 1; i < lines.length; i++) {
      const c = cellsOf(lines[i]);
      if (/^Total buy/i.test(c[0])) {
        buyTotal = rupees(c[1]);
        break;
      }
      if (/^UNIVEST WEALTH/i.test(c[0])) break;
      if (c.length >= 3 && /^₹[\d,.]+$/.test(c[1]) && !c[0].includes("·")) {
        const amount = rupees(c[1]);
        if (amount === null) continue;
        const next = cellsOf(lines[i + 1] ?? "");
        const meta = next[0]?.includes("·") ? next[0].split("·").map((s) => s.trim()) : [];
        buys.push({
          fund: c[0],
          amc: meta[0] ?? null,
          category: meta[1] ?? null,
          planType: planTypeOf(meta.slice(2).join(" ")) ?? planTypeOf(c[0]),
          amount,
          mode: c[2] ?? null,
          fundedBy: c[3] ?? null,
        });
      }
    }
    if (buyTotal === null) warnings.push("Buy table total row not found.");
  }

  // ---------------- SIP table ----------------
  const sips: ReportSipRow[] = [];
  let sipCurrent: number | null = null;
  let sipNext: number | null = null;
  const ph = findHeader(lines, "FUND", "CURRENT SIP", "NEW SIP", "CHANGE");
  if (ph >= 0) {
    for (let i = ph + 1; i < lines.length; i++) {
      const c = cellsOf(lines[i]);
      if (/^Total monthly SIP/i.test(c[0])) {
        sipCurrent = rupees(c[1]);
        sipNext = rupees(c[2]);
        break;
      }
      if (/^UNIVEST WEALTH/i.test(c[0])) break;
      if (c.length < 4) continue;
      const change = c[3];
      const isNum = (x: string) => x === "—" || x === "-" || /^[\d,]+$/.test(x);
      if (!isNum(c[1]) || !isNum(c[2]) || !/^(new|start|stop|increase|decrease|change|continue|no change)/i.test(change)) continue;
      const [fundName, ...rest] = c[0].split("·").map((s) => s.trim());
      const current = rupees(c[1]);
      const next = rupees(c[2]);
      const kind: ReportSipRow["change"] = /^(new|start)/i.test(change) ? "START" : /^stop/i.test(change) ? "STOP" : "CHANGE";
      if (/^(continue|no change)/i.test(change)) continue;
      sips.push({ fund: fundName, planType: planTypeOf(fundName), current, next, change: kind, changeText: change, frequencyNote: rest.join(" · ") || null });
    }
  }

  // Deployment plan (informational, stored in plan notes).
  const deploymentNotes: string[] = [];
  const dh = lines.findIndex((l) => /^What happens, day by day/i.test(l));
  if (dh >= 0) {
    for (let i = dh + 1; i < Math.min(lines.length, dh + 40); i++) {
      if (/^Univest Wealth Portfolio Report/i.test(lines[i]) || /^UNIVEST WEALTH/.test(lines[i])) break;
      deploymentNotes.push(lines[i].replace(/ \| /g, " — "));
    }
  }

  // ---------------- Cross-checks ----------------
  const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;
  const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(2, Math.abs(b) * 0.001);
  if (sellTotal !== null && !close(sum(sells.map((s) => s.value)), sellTotal)) {
    warnings.push(`Sell rows add up to ₹${sum(sells.map((s) => s.value)).toLocaleString("en-IN")} but the report total is ₹${sellTotal.toLocaleString("en-IN")}.`);
  }
  if (buyTotal !== null && !close(sum(buys.map((b) => b.amount)), buyTotal)) {
    warnings.push(`Buy rows add up to ₹${sum(buys.map((b) => b.amount)).toLocaleString("en-IN")} but the report total is ₹${buyTotal.toLocaleString("en-IN")}.`);
  }
  if (sipNext !== null) {
    const next = sum(sips.filter((s) => s.change !== "STOP").map((s) => s.next ?? 0));
    if (!close(next, sipNext)) warnings.push(`New SIPs add up to ₹${next.toLocaleString("en-IN")}/month but the report says ₹${sipNext.toLocaleString("en-IN")}.`);
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
    deploymentNotes,
    warnings,
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
