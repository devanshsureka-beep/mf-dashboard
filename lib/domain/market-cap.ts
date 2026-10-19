/**
 * Where a client's money sits: by market cap, asset class or AMC, now and after the active plan.
 * Pure: holding rows and plan lines in, slices out. Market cap comes from each fund's AMFI
 * category (index funds and ETFs by their index), so diversified funds (flexi, multi, focused,
 * value, contra, ELSS) stay one "Flexi / multi" bucket: their exact large / mid / small split
 * would need the funds' monthly portfolio files.
 */
import { amcName, assetClass, ASSET_CLASSES } from "./book";

export const CAP_BUCKETS = ["Large cap", "Large & mid", "Mid cap", "Small cap", "Flexi / multi", "Sectoral", "Other"] as const;
export type CapBucket = (typeof CAP_BUCKETS)[number];

/** What each bucket holds, for the hover text. */
export const CAP_HINT: Partial<Record<CapBucket, string>> = {
  "Flexi / multi": "Flexi, multi, focused, value, contra and ELSS funds: they hold large, mid and small companies together",
  Sectoral: "Sectoral and thematic funds",
  Other: "Debt, hybrid, gold & silver, overseas and other fund-of-funds",
};

const tailOf = (category: string) => (category.includes(" - ") ? category.split(/\s+-\s+/).slice(1).join(" - ") : category).toLowerCase();

/** An index fund / ETF by the index it tracks. */
function capFromIndexName(n: string): CapBucket | null {
  const s = n.toLowerCase();
  // "Ex-Top 100" long-short funds hold everything outside the largest companies.
  if (/ex[- ]?top/.test(s)) return "Flexi / multi";
  // Factor and thematic indices first: "Nifty 200 Momentum 30" is a factor fund, not the Nifty 200.
  if (/bank|financial|capital markets?|power|\bit\b|tech|pharma|health|fmcg|consumption|auto|infra|psu|cpse|energy|realty|metal|commodit|manufacturing|defence|digital|tourism|momentum|quality|value|alpha|low vol|dividend (yield|opportunit)|esg|equal weight/.test(s)) return "Sectoral";
  if (/large ?(&|and)? ?mid ?cap|largemidcap|nifty large ?mid/.test(s)) return "Large & mid";
  // "Midsmallcap 400" holds mid and small companies together.
  if (/mid ?small ?cap|midsmallcap/.test(s)) return "Flexi / multi";
  if (/small ?cap|smallcap|microcap|micro ?cap/.test(s)) return "Small cap";
  if (/mid ?cap|midcap/.test(s)) return "Mid cap";
  if (/nifty ?500|total market|multi ?cap|multicap|nifty ?200\b|bse ?500|flexi/.test(s)) return "Flexi / multi";
  if (/\bnifty index\b|nifty ?50\b|nifty next 50|next 50|nifty ?100\b|sensex|bse ?100\b|large ?cap|largecap|bluechip|top 100/.test(s)) return "Large cap";
  return null;
}

/** The market-cap bucket of a fund from its AMFI category (and name, for index funds and ETFs). */
export function marketCap(category: string | null, schemeName: string): CapBucket {
  if (assetClass(category, schemeName) !== "Equity") return "Other";
  const t = category?.trim() ? tailOf(category) : "";
  if (/large ?(&|and) ?mid/.test(t)) return "Large & mid";
  if (/large ?cap/.test(t)) return "Large cap";
  if (/mid ?cap/.test(t)) return "Mid cap";
  if (/small ?cap/.test(t)) return "Small cap";
  if (/flexi|multi ?cap|focused|value|contra|elss|tax ?saver|dividend yield/.test(t)) return "Flexi / multi";
  if (/sector|thematic/.test(t)) return "Sectoral";
  return capFromIndexName(schemeName) ?? "Flexi / multi";
}

export interface MixRow { name: string; category: string | null; amc: string | null; value: number }
export type MixBy = "cap" | "class" | "amc";
export interface MixSlice { label: string; now: number; after: number; nowShare: number; afterShare: number; hint?: string }

const keyOf = (by: MixBy, r: MixRow) => (by === "cap" ? marketCap(r.category, r.name) : by === "class" ? assetClass(r.category, r.name) : amcName(r.amc));

/**
 * Now (holdings) and after the plan (holdings + what each plan line still has to do), grouped.
 * Market cap and asset class keep their fixed order; AMCs go largest first, the rest folded into "Other".
 */
export function mix(holdings: readonly MixRow[], planDeltas: readonly MixRow[], by: MixBy, maxAmc = 6): { slices: MixSlice[]; now: number; after: number } {
  const now = new Map<string, number>(), after = new Map<string, number>();
  for (const r of holdings) {
    if (!(r.value > 0)) continue;
    const k = keyOf(by, r);
    now.set(k, (now.get(k) ?? 0) + r.value);
    after.set(k, (after.get(k) ?? 0) + r.value);
  }
  for (const d of planDeltas) {
    if (!d.value) continue;
    const k = keyOf(by, d);
    after.set(k, Math.max(0, (after.get(k) ?? 0) + d.value)); // a sell never takes a group below zero
  }
  const totalNow = [...now.values()].reduce((t, v) => t + v, 0);
  const totalAfter = [...after.values()].reduce((t, v) => t + v, 0);
  let labels: string[];
  if (by === "cap") labels = [...CAP_BUCKETS];
  else if (by === "class") labels = [...ASSET_CLASSES];
  else {
    const ranked = [...new Set([...now.keys(), ...after.keys()])].sort((a, b) => (now.get(b) ?? 0) - (now.get(a) ?? 0) || (after.get(b) ?? 0) - (after.get(a) ?? 0));
    const keep = ranked.filter((k) => k !== "Other").slice(0, maxAmc);
    const rest = ranked.filter((k) => !keep.includes(k));
    for (const k of rest) {
      if (k === "Other") continue;
      now.set("Other", (now.get("Other") ?? 0) + (now.get(k) ?? 0));
      after.set("Other", (after.get("Other") ?? 0) + (after.get(k) ?? 0));
    }
    labels = rest.length ? [...keep, "Other"] : keep;
  }
  const slices = labels
    .map((label) => {
      const n = now.get(label) ?? 0, a = after.get(label) ?? 0;
      return {
        label, now: n, after: a,
        nowShare: totalNow > 0 ? n / totalNow : 0, afterShare: totalAfter > 0 ? a / totalAfter : 0,
        hint: by === "cap" ? CAP_HINT[label as CapBucket] : undefined,
      };
    })
    .filter((s) => s.now >= 0.5 || s.after >= 0.5);
  return { slices, now: totalNow, after: totalAfter };
}
