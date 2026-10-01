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
import { reportAiAnswerSchema, type ReportAiAnswer } from "@/lib/integrations/contracts";
import { AppError } from "@/lib/errors";
import type { PlanHolding } from "@/lib/domain/report-plan";
import { mapRisk, type AdvisoryReportParse } from "@/lib/parsers/advisory-report";

export const REPORT_AI_MODEL = "claude-sonnet-5-5";

export function reportAiConfigured(): boolean {
  return Boolean(process.env.REPORT_AI_URL?.trim() && process.env.REPORT_AI_KEY?.trim());
}

// ---------------------------------------------------------------------------
// Answer shape (JSON schema for Claude, zod for us)
// ---------------------------------------------------------------------------
// Claude's structured output allows few optional (union) fields, so the schema
// has none: "" / 0 / "UNKNOWN" mean "not in the report" and are turned back
// into null below.
const PLAN = { type: "string", enum: ["DIRECT", "REGULAR", "UNKNOWN"] };
const TEXT = (description?: string) => ({ type: "string", ...(description ? { description } : {}) });
const NUM = (description?: string) => ({ type: "number", ...(description ? { description } : {}) });
const obj = (properties: Record<string, unknown>) => ({
  type: "object", additionalProperties: false, properties, required: Object.keys(properties),
});

export const REPORT_AI_SCHEMA = obj({
  client_name: TEXT("\"\" if not shown"),
  report_cas_date: TEXT("Valuation / statement date of the CAS the report was made from (\"values as on\", \"statement period to\"), YYYY-MM-DD; \"\" if the report does not print one. Never the date the report was prepared."),
  prepared_date: TEXT("Date the report was prepared, YYYY-MM-DD; \"\" if not shown"),
  portfolio_value: NUM("0 if not shown"),
  risk_profile: TEXT("\"\" if not shown"),
  goal: TEXT("\"\" if not shown"),
  sells: {
    type: "array",
    items: obj({
      fund: TEXT(),
      folio: TEXT("\"\" unless the report prints it"),
      folio_count: { type: "integer", description: "Folios this one row covers (1 unless the report says e.g. '2 folios')" },
      plan_type: PLAN,
      partial: { type: "boolean", description: "true when only part of the holding is sold now" },
      value: NUM("Rupees sold now (for a full exit: the value the report shows)"),
    }),
  },
  sell_total: NUM("0 if the report prints no sell total"),
  buys: {
    type: "array",
    items: obj({
      fund: TEXT(),
      plan_type: PLAN,
      amount: NUM(),
      kind: { type: "string", enum: ["NEW", "TOP_UP"] },
      amc: TEXT("\"\" if not shown"),
      category: TEXT("\"\" if not shown"),
    }),
  },
  buy_total: NUM("0 if the report prints no buy total"),
  sips: {
    type: "array",
    items: obj({
      fund: TEXT(),
      plan_type: PLAN,
      change: { type: "string", enum: ["START", "STOP", "CHANGE"] },
      current: NUM("Monthly amount before (0 for a new SIP)"),
      next: NUM("Monthly amount after (0 when stopped)"),
    }),
  },
  holds: {
    type: "array",
    items: obj({
      fund: TEXT(),
      folio: TEXT("\"\" unless the report prints it"),
      folio_count: { type: "integer" },
      plan_type: PLAN,
      value: NUM("Value the report shows; 0 if it shows none"),
      deferred: { type: "boolean", description: "true for 'exit later' / sell in a later tranche" },
      note: TEXT("\"\" if none"),
    }),
  },
  report_kind: {
    type: "string", enum: ["FULL_REVIEW", "ADDITIONAL_INVESTMENT"],
    description: "ADDITIONAL_INVESTMENT when the report only plans fresh money the client is adding (on top of an earlier plan); FULL_REVIEW when it reviews and rebalances the whole portfolio.",
  },
  fresh_money: NUM("Fresh money the client is adding that the report invests (rupees); 0 if none"),
  cas_funds_not_in_report: {
    type: "array",
    description: "CAS fund names (exactly as in the CAS list) that the report does not mention anywhere, after searching every page.",
    items: { type: "string" },
  },
  corrections: {
    type: "array",
    description: "Short notes: what differs from the draft you were given and why (empty if nothing).",
    items: { type: "string" },
  },
});

export { reportAiAnswerSchema, type ReportAiAnswer };

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------
const SYSTEM = `You read Indian mutual-fund advisory (rebalancing) reports for a SEBI-registered investment adviser's internal desk.
Return the report's own recommendations in the given JSON shape. Your answer is checked line by line against the client's CAS by software, and an adviser reviews the result.

Rules:
- Report only what the report says. Never invent a line, an amount or a total. If the report does not print a total, use 0.
- Amounts are rupees as plain numbers: "₹5.2L" = 520000, "₹1.15 Cr" = 11500000, "16,500/mo" = 16500.
- sells: every fund the report sells / exits / redeems / switches out NOW. partial = true when only part is sold ("trim ₹5L", "sell 50%"); value = the rupees sold now. A switch is a sell here plus a buy of the target fund.
- A fund marked TRIM / REDUCE / RIGHT-SIZE without a rupee amount or percentage: put it in sells with partial = true and value 0 (the adviser sets the amount). Never guess an amount.
- holds: every fund the report keeps, holds, continues, or defers ("exit later", "next tranche", "after 1 year") with the value the report shows for it (null if none). deferred = true for anything to be sold later, not now.
- buys: lump-sum purchases. kind = TOP_UP when the client already holds that fund (see the CAS list), else NEW.
- sips: START (new), STOP, or CHANGE (amount changes) with the monthly amount before (current) and after (next).
- plan_type: DIRECT or REGULAR when the report or the matching CAS fund shows it; otherwise UNKNOWN.
- folio: only when the report prints it, else "". folio_count: how many folios one row covers (1 unless the report says otherwise).
- Anything the report does not show: "" for text, 0 for amounts.
- Use the CAS fund list to identify which fund / folio a report line means and to write the fund name exactly as the CAS writes it (same fund, same plan type).
- A CAS fund must not be invented into sells/holds. If, after searching every page (tables, notes, footnotes, annexures, "no change" / "continue" lists), the report never mentions a CAS fund, list its CAS name in cas_funds_not_in_report.
- You get a draft (from the built-in reader or your previous attempt) and the points that still do not reconcile with the CAS. Keep draft lines that are right, fix the rest, and list each change in corrections (one short line each). How to resolve each kind of point:
  * "... is in the CAS but not covered by the report": find that fund in the report under any name. If the report keeps / holds / continues it or only changes its SIP, add it to holds with the value the report shows (0 if none). If it is sold, add the sell. If it is truly not in the report, put it in cas_funds_not_in_report.
  * "the report values it at A, the CAS at B" / "full exit ... CAS holding is ...": check you took the right row, folio and plan type, and that the value is the report's printed value for that fund (sum the folios when one row covers several). Do not copy the CAS value unless the report prints it.
  * "... does not match any fund in the CAS" / "is not in the CAS": if it is the same fund as a CAS fund, write the CAS name and plan type; if the client does not hold it, it is a NEW buy, not a hold, sell or SIP change.
  * "marked top-up, but no ... holding": use kind NEW unless the client holds that fund in that plan type.
  * "sell lines add up to X, but the report's sell total is Y" (same for buys): re-read every line and the printed total; a line is missing, duplicated or misread.
  * "reviews X ... not in the CAS" / "both sells it and keeps it": each fund appears once, as a sell (partial or full), a hold, or neither.
- report_kind: ADDITIONAL_INVESTMENT when the report plans fresh money the client is adding on top of an earlier plan (it does not review every holding); then the CAS funds it does not mention are NOT listed in cas_funds_not_in_report, and fresh_money is the amount being added. FULL_REVIEW otherwise.
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
    mentioned_without_value: d.mentioned.map((m) => m.fund),
    cas_funds_not_in_report: d.notInReport ?? [],
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
        { type: "text", text: `Client's CAS, the current draft and the points to fix:\n${JSON.stringify(context)}\n\nRead the attached advisory report and return its recommendations.` },
      ],
    }],
  };
}

// ---------------------------------------------------------------------------
// Answer -> the report shape every check already understands
// ---------------------------------------------------------------------------
const TRIM_NOTE = "TRIM advised in the report, amount not stated: advisor to set the amount before issuing the call.";
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
  for (const x of [...a.sells, ...a.buys, ...a.sips, ...a.holds]) if (!x.fund) problems.push("Claude returned a line without a fund name.");
  // "TRIM" / "REDUCE" with no amount is advice without a size: kept for now, the advisor sets the amount.
  const trimNoAmount = a.sells.filter((x) => !x.value && x.partial);
  for (const x of a.sells) if (!x.value && !x.partial) problems.push(`Exit of ${x.fund}: no amount found in the report.`);
  for (const x of a.buys) if (!x.amount) problems.push(`Buy of ${x.fund}: no amount found in the report.`);
  return {
    template: "AI_ASSISTED",
    clientName: a.client_name ?? base?.clientName ?? null,
    riskProfile: mapRisk(a.risk_profile) ?? base?.riskProfile ?? null,
    reportKind: a.report_kind === "ADDITIONAL_INVESTMENT" ? "ADDITIONAL" : a.report_kind === "FULL_REVIEW" ? "FULL" : (base?.reportKind ?? null),
    freshMoney: a.fresh_money ?? base?.freshMoney ?? null,
    goal: a.goal ?? base?.goal ?? null,
    casPeriod: { from: base?.casPeriod.from ?? null, to: base?.casPeriod.to ?? null },
    valuationDate: a.report_cas_date ?? base?.valuationDate ?? null,
    preparedDate: a.prepared_date ?? base?.preparedDate ?? null,
    currentValue: a.portfolio_value ?? base?.currentValue ?? null,
    sells: a.sells.filter((s) => s.value > 0).map((s) => ({
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
    mentioned: [
      ...a.holds.filter((h) => h.value === null).map((h) => ({
        fund: h.fund, planType: h.plan_type, folio: h.folio, folioCount: h.folio_count,
        note: [h.deferred ? "Exit later (not now)" : "Kept", h.note].filter(Boolean).join(": "),
      })),
      ...trimNoAmount.map((t) => ({ fund: t.fund, planType: t.plan_type, folio: t.folio, folioCount: t.folio_count, note: TRIM_NOTE })),
    ],
    notInReport: a.cas_funds_not_in_report,
    deploymentNotes: [
      ...trimNoAmount.map((t) => `${t.fund}: the report says TRIM but gives no amount. Kept for now; set the amount before issuing the call.`),
      ...(base?.deploymentNotes ?? []).filter((n) => !/^Report read with Claude|^  - |the report says TRIM but gives no amount/.test(n)),
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
  if (res.status === 404) throw new AppError("n8n says this webhook address does not exist (404): REPORT_AI_URL must be exactly the Production URL shown in the n8n Webhook node, and the workflow must be published.");
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
  if (!answer.success) {
    const first = answer.error.issues[0];
    throw new AppError(`Claude's answer did not have the expected shape${first ? ` (${first.path.join(".")}: ${first.message})` : ""}.`);
  }
  return { report: answerToReport(answer.data, input.draft), corrections: answer.data.corrections };
}
