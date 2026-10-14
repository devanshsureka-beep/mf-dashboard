/**
 * Reading a CAS whose pages are pictures (scanned, or re-saved with "Microsoft
 * Print to PDF"): the built-in parser has no text to read, so Claude
 * transcribes the statement (through the same n8n relay as the report reader).
 *
 * Claude only copies what is printed; the same deterministic cross-checks as
 * the built-in parser run on its answer, and the snapshot it makes always
 * waits for a person to confirm it (never auto-confirmed).
 */
import { z } from "zod";
import { AppError } from "@/lib/errors";
import { readCasPdf, IMAGE_ONLY_CAS, type CasReadResult } from "@/lib/cas/reader";
import { pdfNeedsPassword } from "@/lib/pdf/text";
import { classifyTransaction, crossCheckCas, isValidIsin, type CasParseOutput, type CasScheme } from "@/lib/parsers/cas";
import { callClaudeRelay, REPORT_AI_MODEL, reportAiConfigured } from "@/lib/integrations/report-ai";

const obj = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, properties, required: Object.keys(properties) });
const T = (description: string) => ({ type: "string", description });
const N = (description: string) => ({ type: "number", description });

// Structured output: every field required; "" and 0 mean "not printed".
export const CAS_AI_SCHEMA = obj({
  investor_name: T("Investor name at the top"),
  email: T("Email at the top, or \"\""),
  mobile: T("Mobile number at the top (digits), or \"\""),
  pan: T("The investor's PAN (10 characters) as printed in the folios"),
  period_from: T("Statement period start, YYYY-MM-DD"),
  period_to: T("Statement period end, YYYY-MM-DD"),
  summary_cost_total: N("Portfolio summary: total cost value (INR), 0 if not printed"),
  summary_market_total: N("Portfolio summary: total market value (INR), 0 if not printed"),
  schemes: {
    type: "array",
    items: obj({
      amc: T("Fund house heading, e.g. \"HDFC Mutual Fund\""),
      scheme_name: T("Scheme name as printed (without the RTA code prefix and without ISIN / Advisor text)"),
      isin: T("ISIN (12 characters), or \"\""),
      folio: T("Folio number as printed"),
      pan: T("PAN printed on this folio"),
      advisor: T("Advisor text, e.g. \"ARN-12345\" or \"DIRECT\", or \"\""),
      closing_units: N("Closing Unit Balance"),
      nav: N("NAV on the valuation date"),
      nav_date: T("Valuation / NAV date, YYYY-MM-DD"),
      market_value: N("Market value (INR)"),
      cost_value: N("Total cost value (INR), 0 if not printed"),
      transactions: {
        type: "array",
        description: "Transactions of the last 6 months before the statement end date, in printed order. Skip stamp-duty and other lines with no units.",
        items: obj({
          date: T("YYYY-MM-DD"),
          description: T("Transaction text as printed"),
          amount: N("Amount (INR); negative when printed in brackets"),
          units: N("Units; negative when printed in brackets"),
          nav: N("Price / NAV"),
          balance_units: N("Unit balance after the transaction"),
        }),
      },
    }),
  },
});

const SYSTEM = `You transcribe Indian mutual-fund Consolidated Account Statements (CAMS / KFintech "CAS") whose pages are images, for a SEBI-registered investment adviser's internal desk.
Copy values exactly as printed: never compute, round, estimate or fill in a value that is not on the page. Amounts and units printed in brackets are negative.
Include every folio of every fund house, including folios with a zero closing balance. Use "" or 0 only when a value is not printed.`;

const str = z.string();
const num = z.number();
const answerSchema = z.object({
  investor_name: str, email: str, mobile: str, pan: str, period_from: str, period_to: str,
  summary_cost_total: num, summary_market_total: num,
  schemes: z.array(z.object({
    amc: str, scheme_name: str, isin: str, folio: str, pan: str, advisor: str,
    closing_units: num, nav: num, nav_date: str, market_value: num, cost_value: num,
    transactions: z.array(z.object({ date: str, description: str, amount: num, units: num, nav: num, balance_units: num })),
  })).min(1),
});
export type CasAiAnswer = z.infer<typeof answerSchema>;

const isoOrNull = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d.trim()) ? d.trim() : null);
const textOrNull = (s: string) => (s.trim() ? s.trim() : null);
const PAN = /^[A-Z]{5}\d{4}[A-Z]$/;

function planType(name: string, advisor: string): "DIRECT" | "REGULAR" | null {
  if (/\bdirect\b/i.test(name)) return "DIRECT";
  if (/\bregular\b/i.test(name)) return "REGULAR";
  if (/arn/i.test(advisor)) return "REGULAR";
  if (/direct|in[az]\d/i.test(advisor)) return "DIRECT";
  return null;
}

/** Claude's transcription -> the shape every CAS check already understands, with the same cross-checks. */
export function answerToCas(a: CasAiAnswer): CasParseOutput {
  const schemes: CasScheme[] = a.schemes.map((s) => ({
    amc: textOrNull(s.amc),
    schemeName: s.scheme_name.trim(),
    rawSchemeLine: s.scheme_name.trim(),
    isin: isValidIsin(s.isin.trim()) ? s.isin.trim() : null,
    folio: s.folio.replace(/\s+/g, ""),
    pan: PAN.test(s.pan.trim()) ? s.pan.trim() : null,
    registrar: null,
    holderName: null,
    planType: planType(s.scheme_name, s.advisor),
    closingUnits: s.closing_units,
    nav: s.nav > 0 ? s.nav : null,
    navDate: isoOrNull(s.nav_date),
    marketValue: s.market_value,
    costValue: s.cost_value > 0 ? s.cost_value : null,
    transactions: s.transactions
      .filter((t) => isoOrNull(t.date) && t.units !== 0)
      .map((t) => {
        const { type, sipCancelled } = classifyTransaction(t.description, t.units);
        return {
          date: isoOrNull(t.date)!, description: t.description.trim(), type,
          amount: t.amount || null, units: t.units, nav: t.nav > 0 ? t.nav : null, balanceUnits: t.balance_units, sipCancelled,
        };
      }),
  }));
  const summaryMarket = a.summary_market_total > 0 ? a.summary_market_total : null;
  const pan = PAN.test(a.pan.trim()) ? a.pan.trim() : null;
  const navDates = schemes.map((s) => s.navDate).filter((d): d is string => Boolean(d)).sort();
  const warnings = [
    "Read by Claude from a picture-only PDF: check the funds and units before confirming the snapshot.",
    ...crossCheckCas(schemes, summaryMarket),
  ];
  if (!pan) warnings.push("The PAN could not be read.");
  return {
    format: "KFIN_CAMS_CONSOLIDATED",
    source: "CAMS",
    investor: { name: textOrNull(a.investor_name), email: textOrNull(a.email)?.toLowerCase() ?? null, mobile: a.mobile.replace(/\D/g, "").slice(-10) || null, pan },
    period: { from: isoOrNull(a.period_from), to: isoOrNull(a.period_to) },
    valuationDate: navDates.length ? navDates[navDates.length - 1] : isoOrNull(a.period_to),
    summaryTotal: { cost: a.summary_cost_total > 0 ? a.summary_cost_total : null, market: summaryMarket },
    schemes,
    warnings,
    readByAi: true,
  };
}

export function buildCasAiRequest(pdf: Uint8Array) {
  return {
    model: REPORT_AI_MODEL,
    max_tokens: 64000,
    output_config: { effort: "low", format: { type: "json_schema", schema: CAS_AI_SCHEMA } },
    system: SYSTEM,
    messages: [{
      role: "user",
      content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: Buffer.from(pdf).toString("base64") } },
        { type: "text", text: "Transcribe this Consolidated Account Statement." },
      ],
    }],
  };
}

export async function askClaudeForCas(pdf: Uint8Array, timeoutMs = 240_000): Promise<CasParseOutput> {
  const parsed = await callClaudeRelay(buildCasAiRequest(pdf), timeoutMs, "CAS");
  const answer = answerSchema.safeParse(parsed);
  if (!answer.success) {
    const first = answer.error.issues[0];
    throw new AppError(`Claude's reading of the CAS did not have the expected shape${first ? ` (${first.path.join(".")}: ${first.message})` : ""}.`);
  }
  const cas = answerToCas(answer.data);
  if (!cas.investor.pan) throw new AppError("Claude read the CAS but could not read the investor's PAN. Upload the original CAS PDF.");
  return cas;
}

/**
 * The built-in reader first; a CAS whose pages are pictures goes to Claude when
 * it is set up. The snapshot from Claude's reading always waits for a check.
 */
export async function readCasAnyPdf(bytes: Uint8Array, candidates: string[], opts: { timeoutMs?: number } = {}): Promise<CasReadResult> {
  try {
    return await readCasPdf(bytes, candidates);
  } catch (e) {
    if (!(e instanceof AppError) || e.message !== IMAGE_ONLY_CAS || !reportAiConfigured()) throw e;
  }
  // Claude cannot open a locked PDF; a printed copy is normally not locked.
  if (await pdfNeedsPassword(bytes)) throw new AppError(`${IMAGE_ONLY_CAS} (It is also password protected, so it cannot be sent to Claude to read.)`);
  try {
    return { parsed: await askClaudeForCas(bytes, opts.timeoutMs), passwordProtected: false };
  } catch (e) {
    const why = e instanceof AppError ? e.message : "Claude could not read it.";
    throw new AppError(`This CAS PDF has no text (its pages are pictures), so it was sent to Claude to read, which failed: ${why} Upload the original CAS PDF from CAMS / KFintech instead.`);
  }
}

// ---------------------------------------------------------------------------
// Bulk onboarding: what a picture-only PDF is, and whose (a short answer)
// ---------------------------------------------------------------------------
const IDENTIFY_SCHEMA = obj({
  kind: { type: "string", enum: ["CAS", "REPORT", "OTHER"], description: "CAS = CAMS / KFintech Consolidated Account Statement; REPORT = a mutual-fund advisory / rebalancing report" },
  investor_name: T("The investor / client the document is for"),
  pan: T("The investor's PAN if printed, else \"\""),
  statement_date: T("CAS: statement period end, YYYY-MM-DD; else \"\""),
});
const identifySchema = z.object({ kind: z.enum(["CAS", "REPORT", "OTHER"]), investor_name: str, pan: str, statement_date: str });

export async function askClaudeWhatPdfIs(pdf: Uint8Array, timeoutMs = 90_000): Promise<{ kind: "CAS" | "REPORT" | "OTHER"; name: string | null; pan: string | null; date: string | null }> {
  const parsed = await callClaudeRelay({
    model: REPORT_AI_MODEL,
    max_tokens: 2000,
    output_config: { effort: "low", format: { type: "json_schema", schema: IDENTIFY_SCHEMA } },
    system: "You sort documents for an Indian mutual-fund advisory desk. Answer only from what is printed.",
    messages: [{
      role: "user",
      content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: Buffer.from(pdf).toString("base64") } },
        { type: "text", text: "What is this document, and who is it for?" },
      ],
    }],
  }, timeoutMs, "document");
  const a = identifySchema.safeParse(parsed);
  if (!a.success) throw new AppError("Claude's answer did not have the expected shape.");
  return { kind: a.data.kind, name: textOrNull(a.data.investor_name), pan: PAN.test(a.data.pan.trim()) ? a.data.pan.trim() : null, date: isoOrNull(a.data.statement_date) };
}
