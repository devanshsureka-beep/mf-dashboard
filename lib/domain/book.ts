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

/** The asset class of a fund, from its AMFI category (and its name when the category says little). */
export function assetClass(category: string | null, schemeName: string): AssetClass {
  const c = (category ?? "").toLowerCase();
  const n = schemeName.toLowerCase();
  if (/\b(gold|silver|precious)\b/.test(n) || /\bgold\b/.test(c)) return "Gold & silver";
  if (/overseas|international/.test(c) || /\b(international|global|overseas|world|nasdaq|us equity|s&p 500|greater china|japan|emerging market)/.test(n)) return "International";
  if (/hybrid|balanced|arbitrage|multi asset|asset allocation|equity savings/.test(c) || /\b(balanced advantage|arbitrage|multi asset|equity savings|hybrid)\b/.test(n)) return "Hybrid";
  if (/debt|gilt|income|liquid|money market|overnight|bond|duration|credit|banking and psu|floater|fmp|fixed maturity/.test(c)) return "Debt";
  if (/equity|elss|index|etf|large|mid|small|flexi|focused|value|contra|sector|thematic|dividend yield|children|retirement|solution|life cycle|growth/.test(c)) return "Equity";
  if (/\b(liquid|overnight|gilt|bond|debt|money market|duration|corporate)\b/.test(n)) return "Debt";
  if (/\b(cap|equity|elss|tax saver|index|nifty|sensex|flexi|focused|value|contra)\b/.test(n)) return "Equity";
  return "Other";
}

/** "Equity Scheme - Small Cap Fund" → "Small Cap". */
export function shortCategory(category: string | null, schemeName: string): string {
  if (!category) return assetClass(null, schemeName);
  const tail = category.includes(" - ") ? category.split(" - ").slice(1).join(" - ") : category;
  return tail.replace(/\s*\bfunds?\b\s*/gi, " ").replace(/\s+/g, " ").trim() || category;
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
export function insights(rows: readonly BookHolding[], opts: { inBank: number; inBankClients: number }): Insight[] {
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
      href: top[0].security_id ? `/advice/find?fund=${top[0].security_id}` : undefined,
    });
  }

  if (opts.inBank >= 0.5) {
    out.push({
      tone: "info",
      title: `₹${Math.round(opts.inBank).toLocaleString("en-IN")} sold and sitting in bank`,
      detail: `${opts.inBankClients} client${opts.inBankClients === 1 ? "" : "s"} sold and have not bought back yet`,
      clients: [],
      href: "/advice/find?list=cash",
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
export function groupBook(rows: readonly BookHolding[], by: GroupBy): GroupNode[] {
  const total = rows.reduce((t, h) => t + h.value, 0) || 1;
  const levels: ((h: BookHolding) => { key: string; label: string; href?: string })[] =
    by === "category" ? [(h) => ({ key: shortCategory(h.category, h.scheme_name), label: shortCategory(h.category, h.scheme_name) }), fundLevel, clientLevel]
    : by === "amc" ? [(h) => ({ key: h.amc ?? "Unknown AMC", label: h.amc ?? "Unknown AMC" }), fundLevel, clientLevel]
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

function fundLevel(h: BookHolding) {
  return { key: h.security_id ?? h.scheme_name.toLowerCase(), label: fundLabel(h), href: h.security_id ? `/advice/find?fund=${h.security_id}` : undefined };
}
function clientLevel(h: BookHolding) {
  return { key: h.client_id, label: h.client_name, href: `/clients/${h.client_id}` };
}
