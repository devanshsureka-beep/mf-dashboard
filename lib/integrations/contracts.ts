import { z } from "zod";

/**
 * Integration contracts (n8n <-> app). Every inbound payload is validated with
 * these schemas BEFORE anything touches the database. The same schemas are
 * used by the manual "import extraction JSON" screens, so there is exactly one
 * ingestion path. Documented with examples in docs/INTEGRATIONS.md.
 */

const money = z.coerce.number().finite().min(0);
const units = z.coerce.number().finite().min(0);
const isoDate = z.iso.date();
const isin = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/, "Invalid ISIN");
const optionalText = z.string().trim().min(1).optional().nullable();

export const CAS_SOURCES = ["CAMS", "KFINTECH", "NSDL", "CDSL", "MF_CENTRAL", "MANUAL", "OTHER"] as const;
export const TRANSACTION_TYPES = [
  "PURCHASE", "SIP", "REDEMPTION", "SWITCH_IN", "SWITCH_OUT", "DIVIDEND_PAYOUT",
  "DIVIDEND_REINVESTMENT", "BONUS", "MERGER", "STAMP_DUTY", "STT", "TDS", "OTHER",
] as const;

export const casHoldingSchema = z.object({
  scheme_name: z.string().trim().min(1),
  isin: isin.optional().nullable(),
  amc: optionalText,
  folio_number: optionalText,
  plan_type: z.enum(["DIRECT", "REGULAR"]).optional().nullable(),
  category: optionalText,
  units,
  cost_value: money.optional().nullable(),
  current_value: money,
  nav: z.coerce.number().positive().optional().nullable(),
  nav_date: isoDate.optional().nullable(),
});

export const casTransactionSchema = z.object({
  date: isoDate,
  type: z.enum(TRANSACTION_TYPES),
  scheme_name: z.string().trim().min(1),
  isin: isin.optional().nullable(),
  folio_number: optionalText,
  units: z.coerce.number().finite().optional().nullable(),
  nav: z.coerce.number().positive().optional().nullable(),
  amount: z.coerce.number().finite().optional().nullable(),
  balance_units: z.coerce.number().finite().optional().nullable(),
  description: optionalText,
});

export const casParseResultSchema = z.discriminatedUnion("status", [
  z.object({
    cas_document_id: z.uuid(),
    status: z.literal("FAILED"),
    error: z.string().trim().min(1).max(2000),
  }),
  z.object({
    cas_document_id: z.uuid(),
    status: z.literal("PARSED"),
    extraction_method: z.enum(["AI_EXTRACTION", "DETERMINISTIC_PARSER", "MANUAL"]).default("AI_EXTRACTION"),
    statement: z.object({
      source: z.enum(CAS_SOURCES).default("OTHER"),
      statement_from_date: isoDate.optional().nullable(),
      statement_to_date: isoDate.optional().nullable(),
      valuation_date: isoDate,
      investor_name: optionalText,
      investor_pan: z.string().trim().toUpperCase().optional().nullable(),
    }),
    holdings: z.array(casHoldingSchema).min(1, "A parsed CAS must contain at least one holding").max(500),
    transactions: z.array(casTransactionSchema).max(20000).default([]),
    totals: z
      .object({ invested_value: money.optional().nullable(), current_value: money.optional().nullable() })
      .optional()
      .nullable(),
    warnings: z.array(z.string()).default([]),
  }),
]);

export type CasParseResult = z.infer<typeof casParseResultSchema>;
export type CasParsed = Extract<CasParseResult, { status: "PARSED" }>;
export type CasHoldingInput = z.infer<typeof casHoldingSchema>;
export type CasTransactionInput = z.infer<typeof casTransactionSchema>;

// -----------------------------------------------------------------------------
// Advisory report extraction -> DRAFT plan (never ACTIVE)
// -----------------------------------------------------------------------------
export const advisoryPlanItemSchema = z.object({
  action: z.enum(["SELL", "BUY", "RETAIN", "SWITCH", "MIGRATE"]),
  scheme_name: z.string().trim().min(1),
  isin: isin.optional().nullable(),
  folio_number: optionalText,
  target_amount: money.default(0),
  target_units: units.optional().nullable(),
  current_amount: money.optional().nullable(),
  target_weight: z.coerce.number().min(0).max(100).optional().nullable(),
  reason: z.string().trim().max(4000).optional().nullable(),
  priority: z.coerce.number().int().min(1).max(1000).optional().nullable(),
  switch_to_scheme_name: optionalText,
  /** The report's wording could not be read as Buy / Sell / Keep: asked on the plan; the line needs review. */
  question: z.string().trim().max(500).optional().nullable(),
  /** Report vs a newer CAS: what differs and what was done since the report (see lib/domain/report-plan ReportDiff). */
  report_diff: z.object({
    kind: z.enum(["SELL_GONE", "SELL_CHANGED", "KEEP_GONE", "KEEP_CHANGED", "BUY_HELD", "NOT_IN_REPORT", "TRADED"]),
    report_amount: z.number().nullable(), cas_value: z.number(), sold_since: z.number(), bought_since: z.number(),
    suggest: z.enum(["SELL", "BUY", "RETAIN"]), done_amount: z.number(), done_date: z.string().nullable(),
  }).optional().nullable(),
});

export const advisorySipItemSchema = z.object({
  action: z.enum(["START", "STOP", "CHANGE"]),
  scheme_name: z.string().trim().min(1),
  isin: isin.optional().nullable(),
  folio_number: optionalText,
  old_amount: money.optional().nullable(),
  new_amount: money.optional().nullable(),
  frequency: z.enum(["DAILY", "WEEKLY", "MONTHLY", "QUARTERLY"]).default("MONTHLY"),
  debit_day: z.coerce.number().int().min(1).max(31).optional().nullable(),
  notes: optionalText,
});

export const advisoryReportResultSchema = z
  .object({
    client_id: z.uuid().optional(),
    client_code: z.string().trim().regex(/^MN-\d{5}$/).optional(),
    document_id: z.uuid().optional().nullable(),
    status: z.enum(["PARSED", "FAILED"]).default("PARSED"),
    error: z.string().optional().nullable(),
    plan: z.object({
      plan_name: z.string().trim().min(1).max(200),
      plan_date: isoDate.optional().nullable(),
      starting_portfolio_value: money.optional().nullable(),
      notes: z.string().trim().max(8000).optional().nullable(),
      plan_kind: z.enum(["FULL", "ADDITIONAL"]).optional(),
      fresh_money: money.optional().nullable(),
      /** Onboarded with the report as it is (the desk accepted these differences from the CAS). */
      as_reported: z.object({
        reason: z.string().trim().min(3).max(500),
        points: z.array(z.string().max(1000)).max(200),
        outside: z.array(z.object({
          scheme_name: z.string().max(300), isin: z.string().max(20).nullable(), folio_number: z.string().max(60).nullable(), value: z.number(),
        })).max(300),
        by: z.uuid(),
        at: z.string().max(40),
      }).optional().nullable(),
    }),
    items: z.array(advisoryPlanItemSchema).max(300).default([]),
    sip_items: z.array(advisorySipItemSchema).max(100).default([]),
    /** SIPs the report keeps unchanged ("continue"): kept with the plan for the SIP views, never plan lines. */
    unchanged_sips: z.array(z.object({ scheme_name: z.string().max(300), isin: z.string().max(20).nullable(), amount: z.number().nonnegative() })).max(100).optional(),
    declared_totals: z
      .object({
        exit_value: money.optional().nullable(),
        buy_value: money.optional().nullable(),
        sip_value: money.optional().nullable(),
      })
      .optional()
      .nullable(),
    warnings: z.array(z.string()).default([]),
  })
  .refine((v) => Boolean(v.client_id || v.client_code), { message: "client_id or client_code is required" })
  .refine((v) => v.status === "FAILED" || v.items.length + v.sip_items.length > 0, {
    message: "A parsed advisory report must contain at least one item",
  });

export type AdvisoryReportResult = z.infer<typeof advisoryReportResultSchema>;

// -----------------------------------------------------------------------------
// Other inbound triggers
// -----------------------------------------------------------------------------
export const reconciliationTriggerSchema = z.object({
  client_id: z.uuid().optional(),
  client_code: z.string().trim().regex(/^MN-\d{5}$/).optional(),
  current_snapshot_id: z.uuid().optional(),
}).refine((v) => Boolean(v.client_id || v.client_code), { message: "client_id or client_code is required" });

export const casUploadTriggerSchema = z.object({
  client_code: z.string().trim().regex(/^MN-\d{5}$/),
  source: z.enum(CAS_SOURCES).default("OTHER"),
  password_protected: z.coerce.boolean().default(false),
  notes: z.string().trim().max(2000).optional().nullable(),
});

/** Outbound event sent to N8N_NOTIFICATION_WEBHOOK_URL. */
export interface NotificationEvent {
  event:
    | "advice.issued"
    | "advice.revised"
    | "advice.cancelled"
    | "execution.recorded"
    | "cas.parsed"
    | "cas.failed"
    | "reconciliation.completed"
    | "plan.draft_created"
    | "plan.approved";
  occurred_at: string;
  client: { id: string; client_code: string; full_name: string };
  actor?: { id: string; name: string } | null;
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Claude's report reading (lib/integrations/report-ai.ts): the JSON schema sent to
// Claude has no optional fields, so "" / 0 / "UNKNOWN" mean "not shown".
// Accepts Claude's "" / 0 / "UNKNOWN" (and plain nulls) and normalises them to null.
const textZ = z.string().nullable().transform((v) => (v && v.trim() ? v.trim() : null));
const dateZ = z.string().nullable().transform((v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : null));
const planZ = z.enum(["DIRECT", "REGULAR", "UNKNOWN"]).nullable().transform((v) => (v === "UNKNOWN" ? null : v));
const aiAmountZ = z.number().finite().nonnegative();
const countZ = z.number().finite().transform((n) => Math.min(20, Math.max(1, Math.round(n))));
const fundZ = z.string().transform((v) => v.trim());
const optAmountZ = aiAmountZ.nullable().transform((v) => (v ? v : null));
export const reportAiAnswerSchema = z.object({
  client_name: textZ,
  report_cas_date: dateZ,
  prepared_date: dateZ,
  portfolio_value: optAmountZ,
  risk_profile: textZ,
  goal: textZ,
  sells: z.array(z.object({
    fund: fundZ, folio: textZ, folio_count: countZ,
    plan_type: planZ, partial: z.boolean(), value: aiAmountZ,
    // "Trim 33%" -> 33; 0 when the report gives no percentage.
    percent: z.number().min(0).max(100).nullish().transform((p) => (p && p > 0 ? p : null)),
  })).max(200),
  sell_total: optAmountZ,
  buys: z.array(z.object({
    fund: fundZ, plan_type: planZ, amount: aiAmountZ, kind: z.enum(["NEW", "TOP_UP"]),
    amc: textZ, category: textZ,
  })).max(200),
  buy_total: optAmountZ,
  sips: z.array(z.object({
    fund: fundZ, plan_type: planZ, change: z.enum(["START", "STOP", "CHANGE"]),
    current: optAmountZ, next: optAmountZ,
  })).max(200),
  holds: z.array(z.object({
    fund: fundZ, folio: textZ, folio_count: countZ,
    plan_type: planZ, value: optAmountZ, deferred: z.boolean(), note: textZ,
  })).max(300),
  report_kind: z.enum(["FULL_REVIEW", "ADDITIONAL_INVESTMENT"]).nullable().default(null),
  fresh_money: optAmountZ.default(null),
  cas_funds_not_in_report: z.array(z.string()).max(200).default([]),
  // Recommendations Claude could not read as Buy / Sell / Keep: asked to the desk on the plan.
  questions: z.array(z.object({
    fund: fundZ, folio: textZ, folio_count: countZ, plan_type: planZ,
    report_text: z.string().trim().min(1).max(1000), question: z.string().trim().min(1).max(500),
  })).max(100).default([]),
  corrections: z.array(z.string()).max(100),
});
export type ReportAiAnswer = z.output<typeof reportAiAnswerSchema>;
