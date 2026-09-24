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
  action: z.enum(["SELL", "BUY", "RETAIN", "SWITCH"]),
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
    }),
    items: z.array(advisoryPlanItemSchema).max(300).default([]),
    sip_items: z.array(advisorySipItemSchema).max(100).default([]),
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
