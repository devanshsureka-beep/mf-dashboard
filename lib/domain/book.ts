/**
 * The book as the home screen shows it: allocation, a few risks worth a look, and the
 * holdings grouped by category, AMC, advisor or client. Pure: rows in, figures out.
 * Values are each client's latest confirmed CAS units × today's NAV (v_holding_live).
 */

export interface BookHolding {
  client_id: string;
  client_name: string;
  advisor_name: string | null;
  risk_profile: string | null;
  security_id: string | null;
  scheme_name: string;
  /** AMFI category, e.g. "Equity Scheme - Small Cap Fund". */
  category: string | null;
  amc: string | null;
  plan_type: string | null;
  value: number;
}

export type AssetClass = "Equity" | "Debt" | "Hybrid" | "Gold & silver" | "International" | "Other";
export const ASSET_CLASSES: AssetClass[] = ["Equity", "Debt", "Hybrid", "Gold & silver", "International", "Other"];

const GOLD = /\b(gold|silver|precious metals?)\b/i;
const INTL = /\b(international|overseas|nasdaq|s&p 500|us (technology|equity|bluechip|specific)|greater china|japan|taiwan|hang seng|emerging markets?|world|global (innovation|technology|equity|advantage|emerging))\b/i;
const DEBT = /\b(liquid|overnight|gilt|g-?sec|sdl|bonds?|debt|money market|duration|corporate|credit risk|banking (and|&) psu|bharat bond|crisil|ibx|target maturity|floater|fixed maturity|fmp|income)\b/i;
const HYBRID = /\b(balanced advantage|arbitrage|multi[- ]asset|equity savings|hybrid|asset allocation|balanced)\b/i;
const EQUITY = /(cap|equity|elss|tax ?saver|index|nifty|sensex|flexi|focused|value|contra|infrastructure|digital|technology|banking|financial|pharma|health|consumption|momentum|dividend|tiger|manufacturing|psu|sector|thematic|opportunit|bluechip|growth|innovation|esg|quant|business cycle)/i;

/** A fund's class from its name alone (when its category says nothing about it). */
function classFromName(n: string): AssetClass {
  if (GOLD.test(n)) return "Gold & silver";
  if (INTL.test(n)) return "International";
  if (DEBT.test(n)) return "Debt";
  if (HYBRID.test(n)) return "Hybrid";
  if (EQUITY.test(n)) return "Equity";
  return "Other";
}

/**
 * The asset class of a fund: from the AMFI scheme type first ("Debt Scheme - …", "Index Funds -
 * Debt Funds", "Exchange Traded Funds (ETFs) - Gold ETF"); its name decides only for the types
 * that say nothing (ETFs, index funds, fund of funds, "Other Scheme"), or when there is no category.
 */
export function assetClass(category: string | null, schemeName: string): AssetClass {
  const c = (category ?? "").trim();
  if (!c) return classFromName(schemeName);
  const [type, tail = ""] = c.split(/\s+-\s+/, 2);
  const t = type.toLowerCase(), k = tail.toLowerCase();
  if (/gold|silver/.test(k)) return "Gold & silver";
  if (/overseas/.test(c.toLowerCase())) return "International";
  if (/^equity schemes?$|^elss$|^growth$/.test(t)) return "Equity";
  if (/^debt schemes?$|^income|^gilt$/.test(t)) return "Debt";
  if (/^hybrid schemes?$/.test(t)) return "Hybrid";
  if (/^solution oriented|^children|^life cycle/.test(t)) return "Hybrid";
  // Types that do not say what they hold: the tail, else the name.
  if (/\bdebt\b/.test(k)) return "Debt";
  if (/\bhybrid\b/.test(k)) return "Hybrid";
  if (/\bequity\b/.test(k)) return "Equity";
  return classFromName(schemeName);
}

/** "Equity Scheme - Small Cap Fund" → "Small Cap"; no category → "Uncategorised". */
export function shortCategory(category: string | null, _schemeName?: string): string {
  if (!category?.trim()) return "Uncategorised";
  const tail = category.includes(" - ") ? category.split(/\s+-\s+/).slice(1).join(" - ") : category;
  if (/elss|tax saver/i.test(tail)) return "ELSS";
  return tail.replace(/\s*\/\s*/g, " / ").replace(/\s*\bfunds?\b\s*/gi, " ").replace(/\s+/g, " ").trim() || category.trim();
}

const AMC_ALIAS: Record<string, string> = {
  "aditya birla sl": "Aditya Birla Sun Life", "aditya birla sun life": "Aditya Birla Sun Life",
  "parag parikh": "PPFAS", ppfas: "PPFAS", "icici prudential": "ICICI Prudential", "icici": "ICICI Prudential",
  "nippon india": "Nippon India", nippon: "Nippon India", "mirae asset": "Mirae Asset", mirae: "Mirae Asset",
  "motilal oswal": "Motilal Oswal", "franklin templeton": "Franklin Templeton", "canara robeco": "Canara Robeco",
};

/** One name per AMC: "HDFC Mutual Fund", "HDFC" and "HDFC MF" are all "HDFC". */
export function amcName(amc: string | null): string {
  const raw = (amc ?? "").replace(/\b(mutual fund|asset management( company)?|amc|mf|ltd|limited|fund house)\b\.?/gi, " ").replace(/\s+/g, " ").trim();
  if (!raw) return "Unknown AMC";
  const key = raw.toLowerCase();
  if (AMC_ALIAS[key]) return AMC_ALIAS[key];
  // ALL CAPS words of more than 4 letters read better title-cased ("MOTILAL OSWAL" → "Motilal Oswal").
  return raw.split(" ").map((w) => (w.length > 4 && w === w.toUpperCase() ? w[0] + w.slice(1).toLowerCase() : w)).join(" ");
}

export const isRegular = (h: Pick<BookHolding, "plan_type" | "scheme_name">) =>
  h.plan_type === "REGULAR" || (h.plan_type == null && /\bregular\b/i.test(h.scheme_name));

export interface Slice { label: string; value: number; share: number }

/** Shares of the book by a key, largest first; anything past `max - 1` folds into "Other". */
export function slices(rows: readonly BookHolding[], key: (h: BookHolding) => string, max = 7): Slice[] {
  const by = new Map<string, number>();
  for (const h of rows) by.set(key(h), (by.get(key(h)) ?? 0) + h.value);
  const total = [...by.values()].reduce((a, b) => a + b, 0);
  const sorted = [...by.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const head = sorted.length > max ? sorted.slice(0, max - 1) : sorted;
  const rest = sorted.length > max ? sorted.slice(max - 1).reduce((t, [, v]) => t + v, 0) : 0;
  const out = head.map(([label, value]) => ({ label, value, share: total ? value / total : 0 }));
  if (rest > 0) {
    const other = out.find((s) => s.label === "Other");
    if (other) { other.value += rest; other.share = total ? other.value / total : 0; }
    else out.push({ label: "Other", value: rest, share: total ? rest / total : 0 });
  }
  return out;
}

export interface Insight {
  tone: "review" | "info";
  title: string;
  detail: string;
  /** Up to a few clients it is about. */
  clients: { id: string; name: string }[];
  href?: string;
}

/** Risks in the book worth a look. Only what the rows show; nothing is said when it is not true. */
export function insights(rows: readonly BookHolding[], opts: { inBank: number; inBankClients: number; canAdvise?: boolean; advisorId?: string | null }): Insight[] {
  const adv = opts.advisorId ? `&advisor=${opts.advisorId}` : "";
  const out: Insight[] = [];
  const total = rows.reduce((t, h) => t + h.value, 0);
  if (total <= 0) return out;

  // Small-cap heavy clients.
  const perClient = new Map<string, { name: string; risk: string | null; total: number; small: number }>();
  for (const h of rows) {
    const c = perClient.get(h.client_id) ?? { name: h.client_name, risk: h.risk_profile, total: 0, small: 0 };
    c.total += h.value;
    if (/small cap/i.test(h.category ?? "") || (!h.category && /small ?cap/i.test(h.scheme_name))) c.small += h.value;
    perClient.set(h.client_id, c);
  }
  const heavy = [...perClient.entries()].filter(([, c]) => c.total > 0 && c.small / c.total > 0.4).sort((a, b) => b[1].small / b[1].total - a[1].small / a[1].total);
  if (heavy.length) {
    // Small cap suits an aggressive investor; anyone else (or no risk profile yet) is worth a look.
    const notAggressive = heavy.filter(([, c]) => c.risk !== "AGGRESSIVE").length;
    out.push({
      tone: "review",
      title: `${heavy.length} client${heavy.length === 1 ? "" : "s"} hold over 40% in small cap`,
      detail: notAggressive ? `${notAggressive} of them not marked Aggressive` : "all marked Aggressive",
      clients: heavy.slice(0, 4).map(([id, c]) => ({ id, name: c.name })),
    });
  }

  // Concentration in a few funds.
  const funds = new Map<string, { name: string; value: number; security_id: string | null }>();
  for (const h of rows) {
    const k = h.security_id ?? h.scheme_name.toLowerCase();
    const f = funds.get(k) ?? { name: h.scheme_name, value: 0, security_id: h.security_id };
    f.value += h.value;
    funds.set(k, f);
  }
  const top = [...funds.values()].sort((a, b) => b.value - a.value).slice(0, 3);
  const topShare = top.reduce((t, f) => t + f.value, 0) / total;
  if (funds.size > 3 && topShare >= 0.25) {
    out.push({
      tone: "review",
      title: `Top 3 funds are ${Math.round(topShare * 100)}% of the whole book`,
      detail: top.map((f) => `${f.name.replace(/\s*-\s*(direct|regular).*$/i, "")} ${Math.round((f.value / total) * 100)}%`).join(" · "),
      clients: [],
      href: opts.canAdvise !== false && top[0].security_id ? `/advice/find?fund=${top[0].security_id}` : undefined,
    });
  }

  if (opts.inBank >= 0.5) {
    out.push({
      tone: "info",
      title: `₹${Math.round(opts.inBank).toLocaleString("en-IN")} sold and sitting in bank`,
      detail: `${opts.inBankClients} client${opts.inBankClients === 1 ? "" : "s"} sold and have not bought back yet`,
      clients: [],
      href: opts.canAdvise !== false ? `/advice/find?list=cash&waiting=show${adv}` : undefined,
    });
  }

  const regular = rows.filter(isRegular);
  if (regular.length) {
    const ids = new Set(regular.map((h) => h.client_id));
    out.push({
      tone: "info",
      title: `${regular.length} holding${regular.length === 1 ? " is a Regular plan" : "s are Regular plans"}`,
      detail: `₹${Math.round(regular.reduce((t, h) => t + h.value, 0)).toLocaleString("en-IN")} across ${ids.size} client${ids.size === 1 ? "" : "s"}; could move to Direct`,
      clients: [...ids].slice(0, 4).map((id) => ({ id, name: regular.find((h) => h.client_id === id)!.client_name })),
    });
  }
  return out;
}

export type GroupBy = "category" | "amc" | "advisor" | "client";
export const GROUP_BYS: { key: GroupBy; label: string }[] = [
  { key: "category", label: "Category › Fund › Client" },
  { key: "amc", label: "AMC › Fund › Client" },
  { key: "advisor", label: "Advisor › Client › Fund" },
  { key: "client", label: "Client › Fund" },
];

export interface GroupNode { key: string; label: string; value: number; share: number; clients: number; href?: string; children: GroupNode[] }

const fundLabel = (h: BookHolding) => h.scheme_name;

/** The holdings as a tree (two or three levels), largest first at each level. */
export function groupBook(rows: readonly BookHolding[], by: GroupBy, opts: { fundLinks?: boolean } = {}): GroupNode[] {
  const fundLevel = (h: BookHolding) => ({ ...fundLevelOf(h), href: opts.fundLinks === false ? undefined : fundLevelOf(h).href });
  const total = rows.reduce((t, h) => t + h.value, 0) || 1;
  const levels: ((h: BookHolding) => { key: string; label: string; href?: string })[] =
    by === "category" ? [(h) => ({ key: shortCategory(h.category, h.scheme_name), label: shortCategory(h.category, h.scheme_name) }), fundLevel, clientLevel]
    : by === "amc" ? [(h) => ({ key: amcName(h.amc), label: amcName(h.amc) }), fundLevel, clientLevel]
    : by === "advisor" ? [(h) => ({ key: h.advisor_name ?? "No advisor", label: h.advisor_name ?? "No advisor" }), clientLevel, fundLevel]
    : [clientLevel, fundLevel];
  const build = (list: readonly BookHolding[], depth: number): GroupNode[] => {
    if (depth >= levels.length) return [];
    const by = new Map<string, { label: string; href?: string; rows: BookHolding[] }>();
    for (const h of list) {
      const k = levels[depth](h);
      const g = by.get(k.key) ?? { label: k.label, href: k.href, rows: [] };
      g.rows.push(h);
      by.set(k.key, g);
    }
    return [...by.entries()].map(([key, g]) => {
      const value = g.rows.reduce((t, h) => t + h.value, 0);
      return { key, label: g.label, href: g.href, value, share: value / total, clients: new Set(g.rows.map((h) => h.client_id)).size, children: build(g.rows, depth + 1) };
    }).sort((a, b) => b.value - a.value);
  };
  return build(rows, 0);
}

function fundLevelOf(h: BookHolding) {
  return { key: h.security_id ?? h.scheme_name.toLowerCase(), label: fundLabel(h), href: h.security_id ? `/advice/find?fund=${h.security_id}` : undefined };
}
function clientLevel(h: BookHolding) {
  return { key: h.client_id, label: h.client_name, href: `/clients/${h.client_id}` };
}
