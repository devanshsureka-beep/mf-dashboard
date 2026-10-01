/**
 * Claude as a second reader for advisory reports the built-in readers cannot
 * fully reconcile. The request goes to an n8n webhook that holds the Anthropic
 * key (REPORT_AI_URL + REPORT_AI_KEY); the dashboard never sees that key.
 *
 * Claude gets the report PDF, the CAS fund list, the built-in reader's draft
 * and the exact points that failed, and returns the report's lines in a fixed
 * JSON shape. That answer is NOT trusted: it goes through the same CAS
 * tie-out as every other report (buildPlanFromReport), and the plan is still
 * a DRAFT for the advisor. No Next.js imports (tests and scripts use this).
 */
import { z } from "zod";
import { AppError } from "@/lib/errors";
import type { PlanHolding } from "@/lib/domain/report-plan";
import type { AdvisoryReportParse } from "@/lib/parsers/advisory-report";

export const REPORT_AI_MODEL = "claude-opus-5-5";

export function reportAiConfigured(): boolean {
  return Boolean(process.env.REPORT_AI_URL?.trim() && process.env.REPORT_AI_KEY?.trim());
}

// ---------------------------------------------------------------------------
// Answer shape (JSON schema for Claude, zod for us)
// ---------------------------------------------------------------------------
const nullable = (t: Record<string, unknown>) => ({ anyOf: [t, { type: "null" }] });
const PLAN = nullable({ type: "string", enum: ["DIRECT", "REGULAR"] });
const obj = (properties: Record<string, unknown>) => ({
  type: "object", additionalProperties: false, properties, required: Object.keys(properties),
});

export const REPORT_AI_SCHEMA = obj({
  client_name: nullable({ type: "string" }),
  report_cas_date: nullable({ type: "string", description: "Valuation / statement date of the CAS the report was made from, YYYY-MM-DD" }),
  prepared_date: nullable({ type: "string", description: "Date the report was prepared, YYYY-MM-DD" }),
  portfolio_value: nullable({ type: "number" }),
  risk_profile: nullable({ type: "string" }),
  goal: nullable({ type: "string" }),
  sells: {
    type: "array",
    items: obj({
      fund: { type: "string" },
      folio: nullable({ type: "string" }),
      folio_count: { type: "integer", description: "Folios this one row covers (1 unless the report says e.g. '2 folios')" },
      plan_type: PLAN,
      partial: { type: "boolean", description: "true when only part of the holding is sold now" },
      value: { type: "number", description: "Rupees sold now (for a full exit: the value the report shows)" },
    }),
  },
  sell_total: nullable({ type: "number" }),
  buys: {
    type: "array",
    items: obj({
      fund: { type: "string" },
      plan_type: PLAN,
      amount: { type: "number" },
      kind: { type: "string", enum: ["NEW", "TOP_UP"] },
      amc: nullable({ type: "string" }),
      category: nullable({ type: "string" }),
    }),
  },
  buy_total: nullable({ type: "number" }),
  sips: {
    type: "array",
    items: obj({
      fund: { type: "string" },
      plan_type: PLAN,
      change: { type: "string", enum: ["START", "STOP", "CHANGE"] },
      current: nullable({ type: "number", description: "Monthly amount before" }),
      next: nullable({ type: "number", description: "Monthly amount after" }),
    }),
  },
  holds: {
    type: "array",
    items: obj({
      fund: { type: "string" },
      folio: nullable({ type: "string" }),
      folio_count: { type: "integer" },
      plan_type: PLAN,
      value: nullable({ type: "number", description: "Value the report shows; null if it shows none" }),
      deferred: { type: "boolean", description: "true for 'exit later' / sell in a later tranche" },
      note: nullable({ type: "string" }),
    }),
  },
  corrections: {
    type: "array",
    description: "Short notes: what differs from the built-in reader's draft and why (empty if nothing).",
    items: { type: "string" },
  },
});

const planZ = z.enum(["DIRECT", "REGULAR"]).nullable();
const amountZ = z.number().finite().nonnegative();
export const reportAiAnswerSchema = z.object({
  client_name: z.string().nullable(),
  report_cas_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().catch(null),
  prepared_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().catch(null),
  portfolio_value: amountZ.nullable(),
  risk_profile: z.string().nullable(),
  goal: z.string().nullable(),
  sells: z.array(z.object({
    fund: z.string().min(2), folio: z.string().nullable(), folio_count: z.number().int().min(1).max(20),
    plan_type: planZ, partial: z.boolean(), value: amountZ.positive(),
  })).max(200),
  sell_total: amountZ.nullable(),
  buys: z.array(z.object({
    fund: z.string().min(2), plan_type: planZ, amount: amountZ.positive(), kind: z.enum(["NEW", "TOP_UP"]),
    amc: z.string().nullable(), category: z.string().nullable(),
  })).max(200),
  buy_total: amountZ.nullable(),
  sips: z.array(z.object({
    fund: z.string().min(2), plan_type: planZ, change: z.enum(["START", "STOP", "CHANGE"]),
    current: amountZ.nullable(), next: amountZ.nullable(),
  })).max(200),
  holds: z.array(z.object({
    fund: z.string().min(2), folio: z.string().nullable(), folio_count: z.number().int().min(1).max(20),
    plan_type: planZ, value: amountZ.nullable(), deferred: z.boolean(), note: z.string().nullable(),
  })).max(300),
  corrections: z.array(z.string()).max(100),
});
export type ReportAiAnswer = z.infer<typeof reportAiAnswerSchema>;

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------
const SYSTEM = `You read Indian mutual-fund advisory (rebalancing) reports for a SEBI-registered investment adviser's internal desk.
Return the report's own recommendations in the given JSON shape. Your answer is checked line by line against the client's CAS by software, and an adviser reviews the result.

Rules:
- Report only what the report says. Never invent a line, an amount or a total. If the report does not print a total, use null.
- Amounts are rupees as plain numbers: "₹5.2L" = 520000, "₹1.15 Cr" = 11500000, "16,500/mo" = 16500.
- sells: every fund the report sells / exits / redeems / switches out NOW. partial = true when only part is sold ("trim ₹5L", "sell 50%"); value = the rupees sold now. A switch is a sell here plus a buy of the target fund.
- holds: every fund the report keeps, holds, continues, or defers ("exit later", "next tranche", "after 1 year") with the value the report shows for it (null if none). deferred = true for anything to be sold later, not now.
- buys: lump-sum purchases. kind = TOP_UP when the client already holds that fund (see the CAS list), else NEW.
- sips: START (new), STOP, or CHANGE (amount changes) with the monthly amount before (current) and after (next).
- plan_type: DIRECT or REGULAR when the report or the matching CAS fund shows it; otherwise null.
- folio: only when the report prints it. folio_count: how many folios one row covers (1 unless the report says otherwise).
- Use the CAS fund list only to identify which fund / folio a report line means and to write the fund name precisely. A CAS fund the report never mentions must NOT appear in your answer.
- You also get the built-in reader's draft and the points it could not reconcile. Keep its lines that are right, fix the ones that are wrong or missing, and list what you changed in corrections (one short line each).
- Dates as YYYY-MM-DD.`;

export interface ReportAiInput {
  pdf: Uint8Array;
  holdings: PlanHolding[];
  casValuationDate: string | null;
  draft: AdvisoryReportParse | null;
  readerError: string | null;
  problems: string[];
}

/** Draft lines only (no internals), so Claude sees what the reader made of the report. */
function draftSummary(d: AdvisoryReportParse | null) {
  if (!d) return null;
  return {
    client_name: d.clientName,
    report_cas_date: d.valuationDate ?? d.casPeriod.to,
    sells: d.sells.map((s) => ({ fund: s.fund, folio: s.folio, folio_count: s.folioCount ?? 1, plan_type: s.planType ?? null, partial: s.partial, value: s.value })),
    sell_total: d.sellTotal,
    buys: d.buys.map((b) => ({ fund: b.fund, plan_type: b.planType, amount: b.amount, kind: b.kind })),
    buy_total: d.buyTotal,
    sips: d.sips.map((s) => ({ fund: s.fund, plan_type: s.planType, change: s.change, current: s.current, next: s.next })),
    holds: d.holds.map((h) => ({ fund: h.fund, folio: h.folio, value: h.value, note: h.note })),
    reviewed: d.review.map((r) => ({ fund: r.fund, value: r.value, verdict: r.verdictText })),
  };
}

export function buildReportAiRequest(input: ReportAiInput) {
  const context = {
    cas_valuation_date: input.casValuationDate,
    cas_funds: input.holdings.filter((h) => h.current_value > 0).map((h) => ({
      fund: h.scheme_name, folio: h.folio_number, plan_type: h.plan_type ?? null, value: Math.round(h.current_value * 100) / 100,
    })),
    reader_draft: draftSummary(input.draft),
    reader_error: input.readerError,
    points_to_fix: input.problems.slice(0, 80),
  };
  return {
    model: REPORT_AI_MODEL,
    max_tokens: 32000,
    output_config: { effort: "high", format: { type: "json_schema", schema: REPORT_AI_SCHEMA } },
    system: SYSTEM,
    messages: [{
      role: "user",
      content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: Buffer.from(input.pdf).toString("base64") } },
        { type: "text", text: `Client's CAS and the reader's draft:\n${JSON.stringify(context)}\n\nRead the attached advisory report and return its recommendations.` },
      ],
    }],
  };
}

// ---------------------------------------------------------------------------
// Answer -> the report shape every check already understands
// ---------------------------------------------------------------------------
const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(100, Math.abs(b) * 0.005);

export function answerToReport(a: ReportAiAnswer, base: AdvisoryReportParse | null): AdvisoryReportParse {
  const problems: string[] = [];
  const sum = (xs: number[]) => Math.round(xs.reduce((t, x) => t + x, 0) * 100) / 100;
  const sells = sum(a.sells.map((s) => s.value));
  const buys = sum(a.buys.map((b) => b.amount));
  if (a.sell_total !== null && !near(sells, a.sell_total)) problems.push(`The sell lines add up to ${inr(sells)}, but the report's sell total is ${inr(a.sell_total)}.`);
  if (a.buy_total !== null && !near(buys, a.buy_total)) problems.push(`The buy lines add up to ${inr(buys)}, but the report's buy total is ${inr(a.buy_total)}.`);
  for (const s of a.sips) {
    if (s.change !== "STOP" && !s.next) problems.push(`SIP ${s.change.toLowerCase()} in ${s.fund} has no new amount.`);
  }
  return {
    template: "AI_ASSISTED",
    clientName: a.client_name ?? base?.clientName ?? null,
    riskProfile: a.risk_profile ?? base?.riskProfile ?? null,
    goal: a.goal ?? base?.goal ?? null,
    casPeriod: { from: base?.casPeriod.from ?? null, to: base?.casPeriod.to ?? null },
    valuationDate: a.report_cas_date ?? base?.valuationDate ?? null,
    preparedDate: a.prepared_date ?? base?.preparedDate ?? null,
    currentValue: a.portfolio_value ?? base?.currentValue ?? null,
    sells: a.sells.map((s) => ({
      fund: s.fund, folio: s.folio, actionText: s.partial ? "Trim" : "Exit", action: "SELL", partial: s.partial,
      value: s.value, folioCount: s.folio_count, planType: s.plan_type,
    })),
    sellTotal: a.sell_total,
    buys: a.buys.map((b) => ({ fund: b.fund, amc: b.amc, category: b.category, planType: b.plan_type, amount: b.amount, mode: null, fundedBy: null, kind: b.kind })),
    buyTotal: a.buy_total,
    sips: a.sips.map((s) => ({
      fund: s.fund, planType: s.plan_type, current: s.current, next: s.next, change: s.change,
      changeText: s.change === "START" ? "Start" : s.change === "STOP" ? "Stop" : "Change", frequencyNote: null, excludedFromTotal: false,
    })),
    sipTotals: { current: null, next: null },
    sipRouting: [],
    review: [],
    holds: a.holds.filter((h) => h.value !== null).map((h) => ({
      fund: h.fund, folio: h.folio, folioCount: h.folio_count, planType: h.plan_type, value: h.value as number,
      note: [h.deferred ? "Exit later (not now)" : null, h.note].filter(Boolean).join(": "),
    })),
    mentioned: a.holds.filter((h) => h.value === null).map((h) => ({ fund: h.fund, planType: h.plan_type, folio: h.folio, folioCount: h.folio_count })),
    deploymentNotes: [
      ...(base?.deploymentNotes ?? []),
      ...(a.corrections.length ? ["Report read with Claude's help; corrected lines:", ...a.corrections.map((c) => `  - ${c}`)] : ["Report read with Claude's help."]),
    ],
    problems,
    warnings: problems,
  };
}

// ---------------------------------------------------------------------------
// Call (via n8n)
// ---------------------------------------------------------------------------
type MessageBody = { stop_reason?: string; content?: { type: string; text?: string }[]; error?: { message?: string } };

/** Ask Claude (through n8n) to read the report. Throws AppError with a readable reason. */
export async function askClaudeForReport(input: ReportAiInput, timeoutMs = 280_000): Promise<{ report: AdvisoryReportParse; corrections: string[] }> {
  const url = process.env.REPORT_AI_URL?.trim();
  const key = process.env.REPORT_AI_KEY?.trim();
  if (!url || !key) throw new AppError("Claude reading is not set up (REPORT_AI_URL / REPORT_AI_KEY).");
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-desk-key": key },
      body: JSON.stringify({ request: buildReportAiRequest(input) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new AppError("Could not reach the Claude reader (n8n) in time. Try this client again.");
  }
  if (res.status === 401 || res.status === 403) throw new AppError("The n8n Claude reader refused the key (REPORT_AI_KEY does not match the n8n credential).");
  if (res.status === 404) throw new AppError("The n8n Claude reader is not switched on (publish the workflow in n8n).");
  if (!res.ok) throw new AppError(`The n8n Claude reader failed (HTTP ${res.status}).`);
  const wrapped = (await res.json().catch(() => null)) as { status?: number; body?: MessageBody } | null;
  const msg = wrapped?.body;
  if (!wrapped || wrapped.status !== 200 || !msg) {
    throw new AppError(`Claude did not answer (HTTP ${wrapped?.status ?? "?"}${msg?.error?.message ? `: ${msg.error.message}` : ""}).`);
  }
  if (msg.stop_reason === "refusal") throw new AppError("Claude declined to read this report.");
  if (msg.stop_reason === "max_tokens") throw new AppError("Claude's answer was cut off (report too long).");
  const text = msg.content?.find((b) => b.type === "text")?.text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text ?? "");
  } catch {
    throw new AppError("Claude's answer was not valid JSON.");
  }
  const answer = reportAiAnswerSchema.safeParse(parsed);
  if (!answer.success) throw new AppError("Claude's answer did not have the expected shape.");
  return { report: answerToReport(answer.data, input.draft), corrections: answer.data.corrections };
}
