/**
 * AMFI daily NAV file (https://www.amfiindia.com/spages/NAVAll.txt) -> one row
 * per ISIN. Pure; no network.
 *
 * Layout (semicolon separated, with heading lines between blocks):
 *   Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date
 *   Open Ended Schemes(Equity Scheme - Large Cap Fund)      <- category heading
 *   HDFC Mutual Fund                                        <- AMC heading
 *   100119;INF179K01BE2;-;HDFC Large Cap Fund - Growth Option - Regular Plan;1102.33;25-Sep-2026
 *
 * A line can carry two ISINs (growth / payout and IDCW reinvestment); both get
 * the same NAV. "N.A." NAVs and malformed ISINs are skipped.
 */
import { isValidIsin } from "@/lib/parsers/cas";

export interface AmfiScheme {
  isin: string;
  amfi_code: string;
  scheme_name: string;
  amc: string | null;
  category: string | null;
  plan_type: "DIRECT" | "REGULAR" | null;
  option_type: "GROWTH" | "IDCW" | "OTHER";
  nav: number | null;
  nav_date: string | null;
}

export interface AmfiParse {
  schemes: AmfiScheme[];
  /** Latest NAV date in the file (the business day the file is for). */
  navDate: string | null;
  skipped: number;
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

export function amfiDate(s: string): string | null {
  const m = s.trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return null;
  const mon = MONTHS[m[2].toLowerCase()];
  return mon ? `${m[3]}-${mon}-${m[1].padStart(2, "0")}` : null;
}

export function planTypeFromName(name: string): "DIRECT" | "REGULAR" | null {
  const n = name.toLowerCase();
  if (/\bdirect\b/.test(n)) return "DIRECT";
  if (/\bregular\b|\bretail\b/.test(n)) return "REGULAR";
  return null;
}

export function optionTypeFromName(name: string): "GROWTH" | "IDCW" | "OTHER" {
  const n = name.toLowerCase();
  if (/idcw|dividend|payout|reinvest|bonus/.test(n)) return "IDCW";
  if (/growth|\bgr\b|cumulative/.test(n)) return "GROWTH";
  return "OTHER";
}

export function parseAmfiNav(text: string): AmfiParse {
  const out = new Map<string, AmfiScheme>();
  let category: string | null = null;
  let amc: string | null = null;
  let navDate: string | null = null;
  let skipped = 0;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^scheme code;/i.test(line)) continue;
    if (!line.includes(";")) {
      const cat = line.match(/^(?:open|close|interval)[^(]*\((.+)\)\s*$/i);
      if (cat) category = cat[1].trim();
      else amc = line;
      continue;
    }
    const cells = line.split(";").map((c) => c.trim());
    if (cells.length < 6) { skipped++; continue; }
    const [code, isin1, isin2, name, navText, dateText] = cells;
    const navNum = Number(navText.replace(/,/g, ""));
    const nav = Number.isFinite(navNum) && navNum > 0 ? navNum : null;
    const date = amfiDate(dateText);
    if (date && (!navDate || date > navDate)) navDate = date;
    const base = {
      amfi_code: code, scheme_name: name.replace(/\s+/g, " "), amc, category,
      plan_type: planTypeFromName(name), nav, nav_date: nav ? date : null,
    };
    let any = false;
    for (const [isin, option] of [
      [isin1, optionTypeFromName(name)],
      [isin2, "IDCW" as const],
    ] as const) {
      const v = isin.toUpperCase();
      if (!/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(v) || !isValidIsin(v)) continue;
      any = true;
      out.set(v, { ...base, isin: v, option_type: option });
    }
    if (!any) skipped++;
  }
  return { schemes: [...out.values()], navDate, skipped };
}
