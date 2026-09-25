/**
 * Layout-independent reader for advisory reports (any template).
 *
 * Tables are rebuilt from text positions (report-tables.ts) and classified by
 * their columns and the section title printed above them:
 *   - SIP table:        columns "Current …" and "New …"
 *   - sell table:       amount column, title / header about exits / sells / redemptions
 *   - hold table:       amount column, title about deferred / held / later
 *   - buy table:        amount column, title about buys / redeploy / invest
 *   - fund list:        no amount column (status / verdict): used to prove coverage
 * Every table's rows are summed against its printed TOTAL row. The CAS tie-out
 * (report-plan.ts) then checks every line against the client's holdings.
 * Nothing is guessed: anything that does not reconcile is a problem.
 */
import type { PdfPage } from "@/lib/pdf/text";
import { detectPlanType } from "@/lib/domain/securities";
import { parseNumber, toIsoDate } from "./cas";
import { findTables, type ReportTable, type TableColumn } from "./report-tables";
import type { AdvisoryReportParse, ReportBuyRow, ReportSellRow, ReportSipRow } from "./advisory-report";
import { ReportParseError, mapRisk } from "./advisory-report";

const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const amount = (s: string | undefined) => {
  if (!s) return null;
  const t = s.replace(/Rs\.?|₹|\s|\*/gi, "").replace(/[−–]/g, "-");
  if (/^[—-]$/.test(t) || /^n\/a$/i.test(t)) return 0;
  return /^-?[\d,]+(\.\d+)?$/.test(t) ? parseNumber(t) : null;
};

export interface ParsedFundCell {
  name: string;
  planType: "DIRECT" | "REGULAR" | null;
  folio: string | null;
  folioCount: number;
  isNew: boolean;
  topUp: boolean;
}

/** "HDFC Balanced Advantage Fund - Regular (folio 19970693)" -> parts. */
export function parseFundCell(raw: string, planHint?: string): ParsedFundCell {
  const folio = /\(folio\s*(?:no\.?\s*)?([0-9A-Z][0-9A-Z/ ]*?)\s*\)/i.exec(raw)?.[1]?.replace(/\s+/g, "") ?? null;
  const count = Number(/\(x\s*(\d+)\s*folios?\)/i.exec(raw)?.[1] ?? 1);
  const plan = /\b(direct|regular)\b/i.exec(raw)?.[1] ?? /\b(direct|regular)\b/i.exec(planHint ?? "")?.[1] ?? null;
  const name = raw
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s[-–—]\s*(regular|direct)(\s+to\s+(regular|direct))?\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return {
    name,
    planType: plan ? (plan.toLowerCase() === "direct" ? "DIRECT" : "REGULAR") : detectPlanType(raw),
    folio,
    folioCount: count,
    isNew: /\(new\)|\bnew\b/i.test(raw),
    topUp: /top-?\s?up/i.test(raw),
  };
}
const labelled = (f: ParsedFundCell) => (f.planType ? `${f.name} (${f.planType === "DIRECT" ? "Direct" : "Regular"})` : f.name);

const col = (cols: TableColumn[], re: RegExp, not?: RegExp) => cols.find((c) => re.test(c.label) && !(not && not.test(c.label)))?.label ?? null;
const amountCol = (cols: TableColumn[]) => col(cols, /amount|value|\bmv\b|invest|redeem/i, /gain|loss|tax/i);

type Kind = "SIP" | "SELL" | "HOLD" | "BUY" | "LIST" | "UNKNOWN";
function classify(t: ReportTable): Kind {
  const labels = t.columns.map((c) => c.label).join(" | ");
  if (col(t.columns, /current/i) && col(t.columns, /\bnew\b/i) && /sip/i.test(`${labels} ${t.title}`)) return "SIP";
  if (!amountCol(t.columns)) return "LIST";
  const ctx = `${t.title} | ${labels}`;
  if (/defer|held as-is|\bhold\b|later tranche|phase 2|next financial|retain|not sold/i.test(ctx)) return "HOLD";
  if (/\bexit|sell|redeem|redemption/i.test(ctx)) return "SELL";
  if (/redeploy|deploy|\bbuy|invest|purchase/i.test(ctx)) return "BUY";
  return "UNKNOWN";
}

export function looksLikeAdvisoryReport(pages: PdfPage[]): boolean {
  const all = pages.flatMap((p) => p.items.map((i) => i.s)).join(" ");
  return /portfolio|rebalanc|advisory/i.test(all) && /\bfund\b/i.test(all);
}

export function parseAdvisoryReportGeneric(pages: PdfPage[]): AdvisoryReportParse {
  const text = pages.map((p) => p.items.map((i) => i.s).join(" ")).join("\n").replace(/[ \t]+/g, " ");
  const problems: string[] = [];

  const tables = findTables(pages, (cols) =>
    cols.map((c, i) => (/amount|value|\bmv\b|current|\bnew\b|invest/i.test(c.label) && !/gain|loss|tax/i.test(c.label) ? i : -1)).filter((i) => i >= 0),
  );
  if (!tables.length) throw new ReportParseError("No fund tables (with a \"Fund\" column and amounts) were found in this report.");

  const sells: ReportSellRow[] = [];
  const buys: ReportBuyRow[] = [];
  const sips: ReportSipRow[] = [];
  const holds: AdvisoryReportParse["holds"] = [];
  const mentioned: AdvisoryReportParse["mentioned"] = [];
  let sellTotal: number | null = null;
  let buyTotal: number | null = null;
  let sipCurrent: number | null = null;
  let sipNext: number | null = null;
  const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;
  const checkTotal = (what: string, rows: number[], printed: number | null, page: number) => {
    if (printed === null) {
      problems.push(`${what} table (page ${page}) has no printed TOTAL row, so it cannot be verified.`);
      return;
    }
    const s = sum(rows);
    if (Math.abs(s - printed) > Math.max(2, rows.length)) problems.push(`${what} rows add up to ${inr(s)} but the report total is ${inr(printed)} (page ${page}).`);
  };

  for (const t of tables) {
    const kind = classify(t);
    const planCol = col(t.columns, /^plan\b/i);
    if (kind === "SIP") {
      const cur = col(t.columns, /current/i)!;
      const nxt = col(t.columns, /\bnew\b/i)!;
      const curVals: number[] = [];
      const nextVals: number[] = [];
      for (const r of t.rows) {
        const f = parseFundCell(r.fund, planCol ? r.cells[planCol] : undefined);
        const current = amount(r.cells[cur]);
        const next = amount(r.cells[nxt]);
        if (current === null || next === null) {
          problems.push(`SIP row "${r.fund}" (page ${t.page}): amounts unreadable.`);
          continue;
        }
        const starred = /\*/.test(r.cells[cur] ?? "");
        if (!starred) curVals.push(current);
        nextVals.push(next);
        if (current === next) continue; // unchanged SIP
        const change: ReportSipRow["change"] = current === 0 ? "START" : next === 0 ? "STOP" : "CHANGE";
        const note = Object.entries(r.cells).filter(([k]) => ![t.columns[0].label, cur, nxt].includes(k)).map(([, v]) => v).join(" · ");
        sips.push({ fund: labelled(f), planType: f.planType, current: current || null, next: next || null, change, changeText: note.slice(0, 200) || change, frequencyNote: null, excludedFromTotal: starred });
      }
      sipCurrent = amount(t.total?.[cur]);
      sipNext = amount(t.total?.[nxt]);
      checkTotal("Current SIP", curVals, sipCurrent, t.page);
      checkTotal("New SIP", nextVals, sipNext, t.page);
      continue;
    }
    if (kind === "LIST") {
      for (const r of t.rows) {
        const f = parseFundCell(r.fund, planCol ? r.cells[planCol] : undefined);
        if (f.name) mentioned.push({ fund: labelled(f), planType: f.planType, folio: f.folio, folioCount: f.folioCount });
      }
      continue;
    }
    const amt = amountCol(t.columns)!;
    const values: number[] = [];
    const rowsOut: { f: ParsedFundCell; value: number; note: string }[] = [];
    for (const r of t.rows) {
      const f = parseFundCell(r.fund, planCol ? r.cells[planCol] : undefined);
      const value = amount(r.cells[amt]);
      if (!f.name || value === null) {
        problems.push(`Row "${r.fund || "(no fund name)"}" on page ${t.page}: fund or amount unreadable.`);
        continue;
      }
      values.push(value);
      const note = Object.entries(r.cells).filter(([k]) => ![t.columns[0].label, amt].includes(k)).map(([, v]) => v).join(" · ");
      rowsOut.push({ f, value, note });
    }
    const printed = amount(t.total?.[amt]);
    if (kind === "UNKNOWN") {
      problems.push(`A fund table on page ${t.page} ("${t.title.slice(0, 80)}") could not be identified as sells, buys or holds.`);
      continue;
    }
    const what = kind === "SELL" ? "Sell" : kind === "BUY" ? "Buy" : "Held / deferred";
    checkTotal(what, values, printed, t.page);
    const fullExit = /100\s*%|full exit/i.test(`${t.columns.map((c) => c.label).join(" ")} ${t.title}`);
    for (const { f, value, note } of rowsOut) {
      if (kind === "SELL") {
        const partial = !fullExit && /trim|partial|part of|reduce/i.test(note);
        sells.push({ fund: labelled(f), folio: f.folio, folioCount: f.folioCount, actionText: partial ? "Partial sell" : "Full exit", action: /switch/i.test(note) ? "SWITCH" : "SELL", partial, value });
      } else if (kind === "BUY") {
        const category = col(t.columns, /categor/i);
        buys.push({ fund: labelled(f), amc: null, category: category ? r0(t, f, category) : null, planType: f.planType, amount: value, mode: null, fundedBy: null, kind: f.topUp ? "TOP_UP" : f.isNew ? "NEW" : null });
      } else {
        holds.push({ fund: labelled(f), folio: f.folio, folioCount: f.folioCount, planType: f.planType, value, note: note.slice(0, 200) });
      }
    }
    if (kind === "SELL") sellTotal = (sellTotal ?? 0) + (printed ?? 0);
    if (kind === "BUY") buyTotal = (buyTotal ?? 0) + (printed ?? 0);
  }
  if (!sells.length && !buys.length && !sips.length) throw new ReportParseError("No sell, buy or SIP table could be read from this report.");

  // Report details (best effort; checked against the CAS where it matters).
  const clientName = /Portfolio Report\s*[—-]\s*(.+?)\s*[—-]\s*Page \d+/i.exec(text)?.[1]?.trim() ?? /Client\s*:\s*([A-Za-z][A-Za-z .'-]+?)\s*(?:\||$|\n)/i.exec(text)?.[1]?.trim() ?? null;
  if (!clientName) problems.push("Client name not found in the report.");
  const date = (re: RegExp) => { const m = re.exec(text); return m ? toIsoDate(m[1]) : null; };
  const period = /statement period\s*(\d{2}-[A-Za-z]{3}-\d{4})\s*to\s*(\d{2}-[A-Za-z]{3}-\d{4})/i.exec(text);
  const riskText = /\b(moderately aggressive|moderately conservative|aggressive|conservative|moderate)\b[^.\n]{0,40}\b(mandate|risk|profile|investor|tilt)/i.exec(text)?.[0] ?? null;

  let currentValue: number | null = null;
  for (const p of pages) {
    const label = p.items.find((i) => /TOTAL PORTFOLIO VALUE|CURRENT (PORTFOLIO )?VALUE/i.test(i.s));
    if (!label) continue;
    const below = p.items.filter((i) => i.y < label.y - 2 && i.y > label.y - 40 && Math.abs(i.x - label.x) < 60 && /\d/.test(i.s)).sort((a, b) => b.y - a.y)[0];
    const v = below ? amount(/(Rs\.?|₹)?\s?[\d,]+(\.\d+)?/.exec(below.s)?.[0]) : null;
    if (v) { currentValue = v; break; }
  }

  return {
    template: "GENERIC_TABLES",
    clientName,
    riskProfile: mapRisk(riskText),
    goal: /wealth[- ]creation/i.test(text) ? "Wealth creation" : null,
    casPeriod: { from: period ? toIsoDate(period[1]) : null, to: period ? toIsoDate(period[2]) : null },
    valuationDate: date(/valuation date:?\s*(\d{2}-[A-Za-z]{3}-\d{4})/i),
    preparedDate: date(/prepared:?\s*(\d{2}-[A-Za-z]{3}-\d{4})/i),
    currentValue,
    sells,
    sellTotal,
    buys,
    buyTotal,
    sips,
    sipTotals: { current: sipCurrent, next: sipNext },
    sipRouting: [],
    review: [],
    holds,
    mentioned,
    deploymentNotes: [],
    problems,
    warnings: problems,
  };
}

function r0(t: ReportTable, f: ParsedFundCell, category: string): string | null {
  const row = t.rows.find((r) => parseFundCell(r.fund).name === f.name);
  return row?.cells[category] ?? null;
}
