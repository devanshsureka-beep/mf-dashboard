/**
 * What the advisor writes for a quarterly review (stored in quarterly_reviews.inputs) and the
 * quarter's shared market valuations (market_context.data). Every field is optional: anything
 * left blank is filled from the client's numbers when the report is built.
 */
import { z } from "zod";

const text = (max: number) => z.string().trim().max(max).optional();
const pct = z.coerce.number().min(-50).max(100);

export const FUND_STATUSES = ["GREEN", "AMBER", "RED", "EXIT", "LOCKED"] as const;
export type FundStatus = (typeof FUND_STATUSES)[number];
export const OPEN_STATES = ["OPEN", "PAUSED"] as const;

export const StoryCard = z.object({ when: z.string().trim().max(24), title: z.string().trim().max(40), text: z.string().trim().max(320) });
export const ActionRow = z.object({ title: z.string().trim().max(90), detail: z.string().trim().max(260), when: z.string().trim().max(30) });

export const QuarterlyInputs = z.object({
  tagline: text(140),
  headline: text(220),
  glance: text(900),
  story: z.array(StoryCard).max(5).optional(),
  storySentence: text(400),
  marketNote: text(600),
  planCallout: text(400),
  winnersNote: text(300),
  laggardNote: text(300),
  oldVsNewNote: text(400),
  funds: z.record(z.string(), z.object({ status: z.enum(FUND_STATUSES).optional(), why: text(140) })).optional(),
  rebalanceNote: text(300),
  buyWhy: z.record(z.string(), z.string().trim().max(90)).optional(),
  lumpsum: z.record(z.string(), z.enum(OPEN_STATES)).optional(),
  sipOpen: z.record(z.string(), z.enum(OPEN_STATES)).optional(),
  structureNote: text(700),
  sipNote: text(400),
  sipWhy: z.record(z.string(), z.string().trim().max(90)).optional(),
  noNewMoney: text(200),
  taxNotes: text(700),
  exitLoad: z.coerce.number().min(0).max(1e8).optional(),
  rates: z.object({ bear: pct, nifty: pct, base: pct, moonshot: pct }).optional(),
  actions: z.array(ActionRow).max(8).optional(),
  nextReview: text(40),
  nextReviewNote: text(240),
});
export type QuarterlyInputs = z.infer<typeof QuarterlyInputs>;

export const MarketRow = z.object({ index: z.string().trim().min(1).max(40), peNow: z.coerce.number().positive().max(500), median: z.coerce.number().positive().max(500) });
export const MarketContext = z.object({
  asOf: text(40),
  rows: z.array(MarketRow).max(8).default([]),
  note: text(600),
});
export type MarketContext = z.infer<typeof MarketContext>;

/** Read stored JSON leniently: a field that no longer validates is dropped, not fatal. */
export function readInputs(raw: unknown): QuarterlyInputs {
  const r = QuarterlyInputs.safeParse(raw ?? {});
  if (r.success) return r.data;
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const one = QuarterlyInputs.safeParse({ [k]: v });
    if (one.success) Object.assign(out, one.data);
  }
  return out as QuarterlyInputs;
}

export function readMarket(raw: unknown): MarketContext {
  const r = MarketContext.safeParse(raw ?? {});
  return r.success ? r.data : { rows: [] };
}

/** "GAP" and its reading for a valuation row: more than 10% below the median is cheap, 10% above stretched. */
export function valuationRead(peNow: number, median: number): { gap: number; read: "CHEAP" | "FAIR" | "STRETCHED" } {
  const gap = peNow / median - 1;
  return { gap, read: gap <= -0.1 ? "CHEAP" : gap >= 0.1 ? "STRETCHED" : "FAIR" };
}

/** A fund or line key inside a form field name: dots and other characters encoded (names often hold "."). */
export function fieldKey(key: string): string {
  return encodeURIComponent(key).replace(/\./g, "%2E");
}

const UNSAFE = new Set(["__proto__", "constructor", "prototype"]);

/**
 * The form's fields (dotted names: "funds.<key>.status", "story.2.title", "rates.base"; keys encoded with
 * fieldKey) into the inputs object. Blank fields are left out, so a blank field falls back to the
 * generated text. Unknown or unsafe names are dropped (zod rejects anything else).
 */
export function inputsFromEntries(entries: Iterable<[string, string]>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, raw] of entries) {
    const value = raw.trim();
    if (!value || name.startsWith("$") || name.startsWith("index.")) continue;
    let parts: string[];
    try {
      parts = name.split(".").map((x) => decodeURIComponent(x));
    } catch {
      continue;
    }
    if (parts.some((x) => UNSAFE.has(x) || x === "")) continue;
    let node: Record<string, unknown> = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      const nextIsIndex = /^\d+$/.test(parts[i + 1]);
      if (!Object.prototype.hasOwnProperty.call(node, k)) node[k] = nextIsIndex ? [] : {};
      node = node[k] as Record<string, unknown>;
      if (typeof node !== "object" || node === null) break;
    }
    if (typeof node === "object" && node !== null) node[parts[parts.length - 1]] = value;
  }
  // Arrays from slots: keep the slots' positions (empty slots become blank entries).
  for (const k of ["story", "actions"]) {
    const arr = out[k] as Record<string, string>[] | undefined;
    if (arr) out[k] = Array.from({ length: arr.length }, (_, i) => ({ when: "", title: "", text: "", detail: "", ...(arr[i] ?? {}) }))
      .map((x) => (k === "story" ? { when: x.when, title: x.title, text: x.text } : { title: x.title, detail: x.detail, when: x.when }));
  }
  // Rates are all-or-nothing: a partial set falls back to the defaults for the missing ones.
  if (out.rates) out.rates = { bear: 6.5, nifty: 11, base: 14, moonshot: 18.7, ...(out.rates as object) };
  return out;
}
