/**
 * Deterministic parser for the KFintech + CAMS "Consolidated Account Statement"
 * (detailed, with transactions). Input: text lines from lib/pdf/text.ts
 * (cells separated by " | "). Pure function: no I/O, fully unit-tested.
 *
 * It never guesses: anything it cannot read becomes a warning (→ NEEDS_REVIEW)
 * or a failure with a clear message.
 */
import type { CasParsed, CasTransactionInput } from "@/lib/integrations/contracts";

export interface CasTxn {
  date: string; // YYYY-MM-DD
  description: string;
  type: CasTransactionInput["type"];
  amount: number | null; // signed (redemptions negative)
  units: number | null; // signed
  nav: number | null;
  balanceUnits: number | null;
  sipCancelled?: boolean;
}

export interface CasScheme {
  amc: string | null;
  schemeName: string;
  rawSchemeLine: string;
  isin: string | null;
  folio: string;
  pan: string | null;
  registrar: string | null;
  holderName: string | null;
  planType: "DIRECT" | "REGULAR" | null;
  closingUnits: number | null;
  nav: number | null;
  navDate: string | null;
  marketValue: number | null;
  costValue: number | null;
  transactions: CasTxn[];
}

export interface CasParseOutput {
  format: "KFIN_CAMS_CONSOLIDATED";
  source: "KFINTECH" | "CAMS";
  investor: { name: string | null; email: string | null; mobile: string | null; pan: string | null };
  period: { from: string | null; to: string | null };
  valuationDate: string | null;
  summaryTotal: { cost: number | null; market: number | null };
  schemes: CasScheme[];
  warnings: string[];
}

export class CasParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CasParseError";
  }
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};
const DATE = /\d{2}-[A-Za-z]{3}-\d{4}/;

export function toIsoDate(d: string): string | null {
  const m = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(d.trim());
  if (!m) return null;
  const mm = MONTHS[m[2].toLowerCase()];
  return mm ? `${m[3]}-${mm}-${m[1]}` : null;
}

/** "1,234.50" → 1234.5; "(41,124.65)" → -41124.65; "—"/"" → null */
export function parseNumber(s: string | undefined | null): number | null {
  if (s === undefined || s === null) return null;
  const t = s.trim();
  if (!t || t === "-" || t === "—") return null;
  const neg = /^\(.*\)$/.test(t) || t.startsWith("-");
  const n = Number(t.replace(/[(),\s]/g, "").replace(/^-/, ""));
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

/** Split glued tokens such as "30-Jun-202310-Aug-2023" or "1,852.84206-Feb-2024". */
export function normaliseLine(line: string): string {
  return line.replace(/([0-9A-Za-z])(?=\d{2}-[A-Za-z]{3}-\d{4})/g, "$1 | ").replace(/\s+/g, " ").trim();
}

const NOISE = [
  /^Consolidated Account Statement$/i,
  /^\d{2}-[A-Za-z]{3}-\d{4} To \d{2}-[A-Za-z]{3}-\d{4}$/i,
  /^Amount \| Price \| Unit$/i,
  /^Date \| Transaction \| Units$/i,
  /^\(INR\) \| \(INR\) \| Balance$/i,
  /^Page \|/i,
  /^KFINCASWS-/i,
  /^CAMSCASWS-/i,
  /^@@PAGE_BREAK/,
];

export function classifyTransaction(desc: string): { type: CasTxn["type"]; sipCancelled: boolean } {
  const d = desc.toLowerCase();
  const sipCancelled = /sip\s*cancel/.test(d);
  if (/stamp duty/.test(d)) return { type: "STAMP_DUTY", sipCancelled };
  if (/\bstt\b/.test(d)) return { type: "STT", sipCancelled };
  if (/\btds\b/.test(d)) return { type: "TDS", sipCancelled };
  if (/cancel|reversal|rejection|rejected/.test(d)) return { type: "OTHER", sipCancelled };
  if (/switch[\s-]*(over\s*)?out|lateral shift out|stp[\s-]*out|transfer[\s-]*out/.test(d)) return { type: "SWITCH_OUT", sipCancelled };
  if (/switch[\s-]*(over\s*)?in|lateral shift in|stp[\s-]*in|transfer[\s-]*in|systematic transfer/.test(d)) return { type: "SWITCH_IN", sipCancelled };
  if (/redemption|redeem|repurchase|\bswp\b|systematic withdrawal/.test(d)) return { type: "REDEMPTION", sipCancelled };
  if (/(dividend|idcw).*(reinvest)/.test(d)) return { type: "DIVIDEND_REINVESTMENT", sipCancelled };
  if (/dividend|idcw/.test(d)) return { type: "DIVIDEND_PAYOUT", sipCancelled };
  if (/bonus/.test(d)) return { type: "BONUS", sipCancelled };
  if (/merger|amalgamation/.test(d)) return { type: "MERGER", sipCancelled };
  if (/\bsip\b|systematic investment/.test(d)) return { type: "SIP", sipCancelled };
  if (/purchase|nfo|investment|new fund offer|subscription/.test(d)) return { type: "PURCHASE", sipCancelled };
  return { type: "OTHER", sipCancelled };
}

function cleanSchemeName(raw: string): string {
  let s = raw
    .split(/\s*\(Demat\)|\s*\(Non-Demat\)|\s*\(Advisor|\s*- ISIN|\s*\| Registrar/i)[0]
    .replace(/\s*\|\s*/g, " ")
    .trim();
  s = s.replace(/^[A-Z0-9]{2,12}-(?=\S)/, ""); // strip RTA scheme code "IFIFCDG-"
  s = s.replace(/\s*\((?:formerly|erstwhile)[^)]*\)/gi, "").trim();
  return s.replace(/\s+/g, " ").replace(/\s*-\s*$/, "").trim();
}

function planTypeOf(name: string, headerText: string): "DIRECT" | "REGULAR" | null {
  const n = name.toLowerCase();
  if (/\bdirect\b/.test(n)) return "DIRECT";
  if (/\bregular\b/.test(n)) return "REGULAR";
  if (/advisor\s*:\s*arn/i.test(headerText)) return "REGULAR";
  if (/advisor\s*:\s*(direct|in[az]\d)/i.test(headerText)) return "DIRECT";
  return null;
}

function mostCommon<T>(xs: T[]): T | null {
  const m = new Map<T, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  let best: T | null = null;
  let n = 0;
  for (const [k, v] of m) if (v > n) { best = k; n = v; }
  return best;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** ISIN check digit (ISO 6166): letters to numbers, then Luhn. */
export function isValidIsin(isin: string): boolean {
  if (!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin)) return false;
  const digits = isin.split("").map((ch) => (/[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch)).join("");
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/**
 * The ISIN from a folio's header lines. The CAS prints the header in two
 * columns, so a long scheme name can push the ISIN's end onto the next line
 * ("ISIN: INF769K | Registrar :" / "01101(Advisor: …)"). A split ISIN is
 * re-joined only when the result passes the ISIN check digit.
 */
export function findIsin(header: string[]): string | null {
  for (let i = 0; i < header.length; i++) {
    const m = /ISIN\s*:\s*([A-Z0-9]{2,12})/.exec(header[i]);
    if (!m) continue;
    if (m[1].length === 12) return isValidIsin(m[1]) ? m[1] : null;
    for (const next of header.slice(i + 1, i + 3)) {
      const cont = /^\s*([A-Z0-9]+)/.exec(next.split(" | ").find((c) => /^[A-Z0-9]/.test(c.trim())) ?? "")?.[1] ?? "";
      const candidate = (m[1] + cont).slice(0, 12);
      if (candidate.length === 12 && isValidIsin(candidate)) return candidate;
    }
    return null;
  }
  return null;
}

export function parseCasLines(rawLines: string[]): CasParseOutput {
  const lines = rawLines.map(normaliseLine).filter((l) => l.length > 0);
  const text = lines.join("\n");
  if (!/Consolidated Account Statement/i.test(text) || !/Folio No/i.test(text)) {
    throw new CasParseError("This does not look like a KFintech/CAMS Consolidated Account Statement.");
  }
  if (!/Closing Unit Balance/i.test(text)) {
    throw new CasParseError("This CAS has no closing balances. Upload the DETAILED statement (with transactions), not the summary.");
  }

  const warnings: string[] = [];
  const periodM = /(\d{2}-[A-Za-z]{3}-\d{4}) To (\d{2}-[A-Za-z]{3}-\d{4})/i.exec(text);
  const email = /Email Id\s*:\s*([^\s|]+@[^\s|]+)/i.exec(text)?.[1]?.toLowerCase() ?? null;
  const mobile = /Mobile\s*\|?\s*:\s*\+?(\d[\d\s-]{8,14}\d)/i.exec(text)?.[1]?.replace(/\D/g, "").slice(-10) ?? null;

  // Portfolio summary: AMC names + grand total (before the first folio).
  const firstFolio = lines.findIndex((l) => /^Folio No\s*:/i.test(l));
  const amcNames = new Set<string>();
  let summaryCost: number | null = null;
  let summaryMarket: number | null = null;
  for (const l of lines.slice(0, firstFolio)) {
    const c = l.split(" | ");
    if (c.length === 3 && parseNumber(c[1]) !== null && parseNumber(c[2]) !== null) {
      if (/^total$/i.test(c[0].trim())) {
        summaryCost = parseNumber(c[1]);
        summaryMarket = parseNumber(c[2]);
      } else {
        amcNames.add(c[0].trim().toLowerCase());
      }
    }
  }

  const schemes: CasScheme[] = [];
  let amc: string | null = null;
  let cur: CasScheme | null = null;
  let state: "HEADER" | "TXNS" | "CLOSING" | "IDLE" = "IDLE";
  let header: string[] = [];
  let closing = "";

  const finishHeader = () => {
    if (!cur) return;
    const joined = header.join(" | ");
    const isin = findIsin(header);
    const registrar = /Registrar\s*:\s*([A-Za-z]+)/.exec(joined)?.[1] ?? null;
    // First header line is the holder name when it has no scheme markers.
    const holder = header[0] && !/ISIN|Registrar|Advisor|Demat|-/.test(header[0]) ? header[0].trim() : null;
    const schemeLines = holder ? header.slice(1) : header;
    const raw = schemeLines.join(" | ");
    cur.holderName = holder;
    cur.rawSchemeLine = raw;
    cur.schemeName = cleanSchemeName(raw);
    cur.isin = isin;
    cur.registrar = registrar ? registrar.toUpperCase() : null;
    cur.planType = planTypeOf(cur.schemeName, raw);
    if (!isin) {
      warnings.push(/ISIN\s*:/.test(joined)
        ? `ISIN for folio ${cur.folio} (${cur.schemeName || "unknown scheme"}) could not be read with a valid check digit.`
        : `ISIN not found for folio ${cur.folio} (${cur.schemeName || "unknown scheme"}).`);
    }
    if (!cur.schemeName) warnings.push(`Scheme name not found for folio ${cur.folio}.`);
  };

  const finishClosing = () => {
    if (!cur) return;
    const c = closing;
    cur.closingUnits = parseNumber(/Closing Unit Balance\s*:\s*\|?\s*([\d,]+\.\d+)/i.exec(c)?.[1]);
    const navM = /NAV on (\d{2}-[A-Za-z]{3}-\d{4})\s*:\s*INR\s*([\d,]+\.?\d*)/i.exec(c);
    cur.nav = parseNumber(navM?.[2]);
    cur.navDate = navM ? toIsoDate(navM[1]) : null;
    cur.marketValue = parseNumber(/Market Value on \d{2}-[A-Za-z]{3}-\d{4}\s*:\s*INR\s*([\d,]+\.?\d*)/i.exec(c)?.[1]);
    cur.costValue = parseNumber(/Total Cost Value\s*:\s*INR\s*([\d,]+\.?\d*)/i.exec(c)?.[1]);
    schemes.push(cur);
    cur = null;
    state = "IDLE";
    closing = "";
  };

  // Start just after the portfolio-summary total so the first AMC header is seen.
  const summaryEnd = lines.findIndex((l, idx) => idx < firstFolio && /^Total \|/i.test(l));
  for (let i = Math.max(summaryEnd + 1, 0); firstFolio >= 0 && i < lines.length; i++) {
    const line = lines[i];
    if (NOISE.some((r) => r.test(line))) continue;

    const folioM = /^Folio No\s*:\s*([^|]+?)\s*(?:\||$)/i.exec(line);
    if (folioM) {
      if (cur && state === "CLOSING") finishClosing();
      else if (cur) {
        warnings.push(`Folio ${cur.folio}: closing balance not found.`);
        schemes.push(cur);
      }
      cur = {
        amc, schemeName: "", rawSchemeLine: "", isin: null,
        folio: folioM[1].replace(/\s+/g, ""), pan: /PAN\s*:\s*([A-Z]{5}\d{4}[A-Z])/.exec(line)?.[1] ?? null,
        registrar: null, holderName: null, planType: null, closingUnits: null, nav: null, navDate: null,
        marketValue: null, costValue: null, transactions: [],
      };
      header = [];
      state = "HEADER";
      continue;
    }

    if (state === "CLOSING") {
      if (/Total Cost Value|Market Value on|NAV on/i.test(line) && !/Total Cost Value/i.test(closing)) {
        closing += " | " + line;
        continue;
      }
      finishClosing();
    }

    if (!cur) {
      // Between schemes: AMC headers and load-structure prose.
      if (amcNames.has(line.toLowerCase())) amc = line;
      continue;
    }

    if (state === "HEADER") {
      if (/^Nominee 1/i.test(line) || /^Opening Unit/i.test(line)) {
        finishHeader();
        state = "TXNS";
        continue;
      }
      header.push(line);
      continue;
    }

    if (state === "TXNS") {
      if (/^Opening Unit/i.test(line)) continue;
      if (/^Closing Unit Balance/i.test(line)) {
        closing = line;
        state = "CLOSING";
        continue;
      }
      const cells = line.split(" | ").map((s) => s.trim());
      if (!DATE.test(cells[0] ?? "") || !new RegExp(`^${DATE.source}$`).test(cells[0])) continue;
      // Drop stray leading dates (a rendering artefact of stamp-duty rows).
      let k = 0;
      while (k + 1 < cells.length && new RegExp(`^${DATE.source}$`).test(cells[k + 1])) k++;
      const date = toIsoDate(cells[k]);
      const desc = cells[k + 1];
      if (!date || !desc) continue; // a lone date line
      const nums = cells.slice(k + 2).map(parseNumber);
      const { type, sipCancelled } = classifyTransaction(desc);
      const txn: CasTxn = {
        date, description: desc, type,
        amount: nums[0] ?? null,
        units: nums.length >= 4 ? nums[1] : null,
        nav: nums.length >= 4 ? nums[2] : null,
        balanceUnits: nums.length >= 4 ? nums[3] : null,
        sipCancelled,
      };
      cur.transactions.push(txn);
    }
  }
  if (cur && state === "CLOSING") finishClosing();
  else if (cur) {
    warnings.push(`Folio ${(cur as CasScheme).folio}: closing balance not found.`);
    schemes.push(cur);
  }

  if (schemes.length === 0) throw new CasParseError("No folios could be read from this CAS.");

  // --- Validation (deterministic cross-checks) ---
  for (const s of schemes) {
    const last = [...s.transactions].reverse().find((t) => t.balanceUnits !== null);
    if (last && s.closingUnits !== null && Math.abs(last.balanceUnits! - s.closingUnits) > 0.002) {
      warnings.push(`${s.schemeName} (${s.folio}): last transaction balance ${last.balanceUnits} ≠ closing units ${s.closingUnits}.`);
    }
    if (s.closingUnits && s.nav && s.marketValue !== null) {
      const implied = s.closingUnits * s.nav;
      if (Math.abs(implied - s.marketValue) > Math.max(1, s.marketValue * 0.005)) {
        warnings.push(`${s.schemeName} (${s.folio}): units × NAV ≠ market value.`);
      }
    }
  }
  const market = round2(schemes.reduce((t, s) => t + (s.marketValue ?? 0), 0));
  if (summaryMarket !== null && Math.abs(market - summaryMarket) > 2) {
    warnings.push(`Scheme values add up to ₹${market.toLocaleString("en-IN")} but the portfolio summary says ₹${round2(summaryMarket).toLocaleString("en-IN")}.`);
  }
  const pans = schemes.map((s) => s.pan).filter((p): p is string => Boolean(p));
  const pan = mostCommon(pans);
  const otherPans = [...new Set(pans.filter((p) => p !== pan))];
  if (otherPans.length) warnings.push(`This CAS also contains folios of other PAN(s): ${otherPans.join(", ")} (family consolidation).`);

  const navDate = mostCommon(schemes.map((s) => s.navDate).filter((d): d is string => Boolean(d)));
  const holder = mostCommon(schemes.filter((s) => s.pan === pan).map((s) => s.holderName).filter((n): n is string => Boolean(n)));

  return {
    format: "KFIN_CAMS_CONSOLIDATED",
    source: /CAMSCASWS/i.test(text) ? "CAMS" : "KFINTECH",
    investor: { name: holder ? titleCase(holder) : null, email, mobile, pan },
    period: { from: periodM ? toIsoDate(periodM[1]) : null, to: periodM ? toIsoDate(periodM[2]) : null },
    valuationDate: navDate,
    summaryTotal: { cost: summaryCost, market: summaryMarket },
    schemes,
    warnings,
  };
}

export function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\s+/g, " ").trim();
}

/** Map to the ingestion contract (one path for every CAS source). */
export function toCasParseResult(p: CasParseOutput, casDocumentId: string): CasParsed {
  const primary = p.schemes.filter((s) => !p.investor.pan || !s.pan || s.pan === p.investor.pan);
  const holdings = primary
    .filter((s) => (s.closingUnits ?? 0) > 0.0005)
    .map((s) => ({
      scheme_name: s.schemeName,
      isin: s.isin,
      amc: s.amc,
      folio_number: s.folio,
      plan_type: s.planType,
      category: null,
      units: round4(s.closingUnits ?? 0),
      nav: s.nav,
      nav_date: s.navDate,
      current_value: round2(s.marketValue ?? (s.closingUnits ?? 0) * (s.nav ?? 0)),
      cost_value: s.costValue,
    }));
  const transactions = primary.flatMap((s) =>
    s.transactions.map((t) => ({
      date: t.date,
      type: t.type,
      scheme_name: s.schemeName,
      isin: s.isin,
      folio_number: s.folio,
      units: t.units,
      nav: t.nav,
      amount: t.amount,
      balance_units: t.balanceUnits,
      description: t.description,
    })),
  );
  const valuation = p.valuationDate ?? p.period.to;
  if (!valuation) throw new CasParseError("Could not determine the valuation date of this CAS.");
  return {
    cas_document_id: casDocumentId,
    status: "PARSED",
    extraction_method: "DETERMINISTIC_PARSER",
    statement: {
      source: p.source,
      statement_from_date: p.period.from,
      statement_to_date: p.period.to,
      valuation_date: valuation,
      investor_name: p.investor.name,
      investor_pan: p.investor.pan,
    },
    holdings,
    transactions,
    totals: {
      // The summary total covers every folio; only comparable when all folios are this investor's.
      current_value: p.summaryTotal.market !== null && primary.length === p.schemes.length ? round2(p.summaryTotal.market) : null,
      invested_value: p.summaryTotal.cost,
    },
    warnings: p.warnings,
  };
}

