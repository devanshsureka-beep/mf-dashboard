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

const UNSAFE = new Set(["__proto__", "constructor", "prototype"]);

/**
 * One edit on the review pages: `value` set at `path` ("funds", key, "why"), or removed when undefined
 * (the automatic text comes back). Objects left empty are removed too. Never mutates; unsafe keys are ignored.
 */
export function setInput<T extends object>(obj: T, path: readonly (string | number)[], value: unknown): T {
  if (!path.length || path.some((k) => UNSAFE.has(String(k)))) return obj;
  const [k, ...rest] = path;
  const base = (Array.isArray(obj) ? [...obj] : { ...obj }) as Record<string | number, unknown>;
  if (!rest.length) {
    if (value === undefined) delete base[k];
    else base[k] = value;
    return base as T;
  }
  const cur = base[k];
  const child = cur && typeof cur === "object" ? cur : typeof rest[0] === "number" ? [] : {};
  const next = setInput(child as object, rest, value);
  if (!Array.isArray(next) && Object.keys(next).length === 0) delete base[k];
  else base[k] = next;
  return base as T;
}
