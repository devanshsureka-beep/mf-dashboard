/**
 * Shared TypeScript types. Row types mirror the SQL views/tables in
 * supabase/migrations (numeric -> number, date -> 'YYYY-MM-DD', timestamptz -> Date).
 */

export type AppRole = "ADMIN" | "ADVISOR" | "OPERATIONS";
export type ClientStatus = "PROSPECT" | "ONBOARDING" | "ACTIVE" | "DORMANT" | "CLOSED";
export type RiskProfile =
  | "CONSERVATIVE"
  | "MODERATELY_CONSERVATIVE"
  | "MODERATE"
  | "MODERATELY_AGGRESSIVE"
  | "AGGRESSIVE";
export type PlanStatus = "DRAFT" | "ACTIVE" | "COMPLETED" | "REPLACED" | "CANCELLED";
export type PlanAction = "SELL" | "BUY" | "RETAIN" | "SWITCH" | "STOP_SIP" | "START_SIP";
export type AdviceAction = "BUY" | "SELL" | "SWITCH";
export type AdviceStatus = "ISSUED" | "PARTIALLY_EXECUTED" | "EXECUTED" | "CANCELLED" | "EXPIRED" | "REVISED";
export type Channel = "PHONE" | "WHATSAPP" | "EMAIL" | "IN_PERSON" | "OTHER";
export type VerificationType = "CLIENT_CONFIRMED" | "ADVISOR_CONFIRMED" | "PROOF_VERIFIED" | "CAS_VERIFIED";
export type ExecutionStatus = "PENDING" | "PARTIAL" | "EXECUTED" | "REJECTED" | "CANCELLED";
export type ParseStatus = "UPLOADED" | "PROCESSING" | "PARSED" | "NEEDS_REVIEW" | "FAILED";
export type MatchStatus = "SUGGESTED" | "CONFIRMED" | "REJECTED" | "PARTIAL" | "UNEXPLAINED";

export const RISK_PROFILES: RiskProfile[] = [
  "CONSERVATIVE", "MODERATELY_CONSERVATIVE", "MODERATE", "MODERATELY_AGGRESSIVE", "AGGRESSIVE",
];
export const CLIENT_STATUSES: ClientStatus[] = ["PROSPECT", "ONBOARDING", "ACTIVE", "DORMANT", "CLOSED"];
export const CHANNELS: Channel[] = ["PHONE", "WHATSAPP", "EMAIL", "IN_PERSON", "OTHER"];
export const VERIFICATION_TYPES: Exclude<VerificationType, "CAS_VERIFIED">[] = [
  "CLIENT_CONFIRMED", "ADVISOR_CONFIRMED", "PROOF_VERIFIED",
];

export interface ClientSummary {
  client_id: string;
  client_code: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  pan: string | null;
  onboarding_date: string;
  risk_profile: RiskProfile | null;
  goal: string | null;
  status: ClientStatus;
  next_review_date: string | null;
  created_at: Date;
  advisor_id: string | null;
  advisor_name: string | null;
  latest_snapshot_id: string | null;
  latest_cas_date: string | null;
  current_portfolio_value: number | null;
  initial_portfolio_value: number | null;
  baseline_date: string | null;
  active_plan_id: string | null;
  active_plan_name: string | null;
  target_sell: number;
  advised_sell: number;
  executed_sell: number;
  pending_sell: number;
  yet_to_advise_sell: number;
  target_buy: number;
  advised_buy: number;
  executed_buy: number;
  pending_buy: number;
  yet_to_advise_buy: number;
  open_calls: number;
  pending_total: number;
  off_plan_pending: number;
  unadvised_count: number;
}

export interface TransitionNumbers {
  target: number;
  advised: number;
  executed: number;
  pending: number;
  yetToAdvise: number;
}

export interface PlanRow {
  id: string;
  client_id: string;
  plan_name: string;
  plan_date: string;
  status: PlanStatus;
  baseline_snapshot_id: string | null;
  source_document_id: string | null;
  extraction_source: "MANUAL" | "AI_EXTRACTION" | "IMPORT";
  starting_portfolio_value: number | null;
  target_exit_value: number;
  target_buy_value: number;
  target_sip_value: number;
  approved_target_exit_value: number | null;
  approved_target_buy_value: number | null;
  approved_target_sip_value: number | null;
  notes: string | null;
  approved_at: Date | null;
  approved_by: string | null;
  locked_at: Date | null;
  closed_at: Date | null;
  created_at: Date;
  extraction_payload: unknown;
}

export interface PlanTransition {
  plan_id: string;
  client_id: string;
  plan_name: string;
  status: PlanStatus;
  sell_target: number;
  sell_advised: number;
  sell_executed: number;
  sell_pending: number;
  sell_yet_to_advise: number;
  sell_over_advised: number;
  buy_target: number;
  buy_advised: number;
  buy_executed: number;
  buy_pending: number;
  buy_yet_to_advise: number;
  buy_over_advised: number;
  actionable_items: number;
  completed_items: number;
}

export interface PlanItemProgress {
  plan_item_id: string;
  plan_id: string;
  client_id: string;
  plan_status: PlanStatus;
  security_id: string | null;
  scheme_name: string;
  folio_number: string | null;
  action: PlanAction;
  side: "SELL" | "BUY" | "NONE";
  item_status: "OPEN" | "COMPLETED" | "CANCELLED";
  priority: number;
  reason: string | null;
  notes: string | null;
  needs_review: boolean;
  current_amount: number | null;
  target_weight: number | null;
  target_units: number | null;
  target_amount: number;
  original_target_amount: number;
  advised_amount: number;
  executed_amount: number;
  pending_amount: number;
  yet_to_advise_amount: number;
  over_advised_amount: number;
  target_value: number | null;
  open_calls: number;
  total_calls: number;
  last_advised_at: Date | null;
  completion_pct: number | null;
  advised_pct: number | null;
  progress_status: string;
}

export interface SipItem {
  id: string;
  client_id: string;
  plan_id: string;
  security_id: string | null;
  scheme_name: string;
  folio_number: string | null;
  action: "START" | "STOP" | "CHANGE";
  old_amount: number | null;
  new_amount: number | null;
  frequency: string;
  debit_day: number | null;
  status: "PLANNED" | "ADVISED" | "COMPLETED" | "CANCELLED";
  advised_at: Date | null;
  completed_at: Date | null;
  notes: string | null;
  needs_review: boolean;
}

export interface AdviceItemView {
  id: string;
  advice_batch_id: string;
  batch_code: string;
  client_id: string;
  client_code?: string;
  client_name?: string;
  advisor_id: string;
  advisor_name?: string | null;
  plan_item_id: string | null;
  security_id: string;
  scheme_name: string;
  folio_number: string | null;
  action: AdviceAction;
  quantity_basis: "AMOUNT" | "UNITS";
  advised_amount: number;
  advised_units: number | null;
  reference_price: number | null;
  valid_until: string | null;
  status: AdviceStatus;
  revises_advice_item_id: string | null;
  status_changed_at: Date | null;
  status_reason: string | null;
  communicated_at: Date;
  communication_channel: Channel;
  executed_amount: number;
  executed_units: number;
  unverified_executed_amount: number;
  execution_count: number;
  last_execution_date: string | null;
  counted_advised_amount: number;
  pending_units: number | null;
  is_open: boolean;
  age_days: number;
  pending_amount: number;
  effective_advised_amount: number;
  execution_pct: number | null;
  /** Advised -> executed timing (v_advice_execution_timing), IST calendar days. */
  first_execution_date?: string | null;
  lag_days?: number | null;
  completion_lag_days?: number | null;
  cas_verified?: boolean;
  created_at: Date;
  created_by: string | null;
}

export interface ExecutionRow {
  id: string;
  client_id: string;
  advice_item_id: string;
  security_id: string;
  scheme_name?: string;
  action?: AdviceAction;
  client_name?: string;
  client_code?: string;
  execution_date: string;
  execution_time: string | null;
  executed_amount: number;
  executed_units: number | null;
  execution_price: number | null;
  verification_type: VerificationType;
  status: ExecutionStatus;
  notes: string | null;
  proof_document_id: string | null;
  cas_verified_at: Date | null;
  status_reason: string | null;
  created_at: Date;
  created_by_name?: string | null;
}

export interface SnapshotRow {
  id: string;
  client_id: string;
  cas_document_id: string | null;
  snapshot_date: string;
  total_invested_value: number;
  total_current_value: number;
  total_gain_loss: number;
  source: string;
  extraction_method: string;
  review_status: "PENDING_REVIEW" | "CONFIRMED" | "REJECTED";
  reviewed_at: Date | null;
  review_note: string | null;
  is_baseline: boolean;
  holdings_count: number;
  created_at: Date;
}

export interface HoldingRow {
  id: string;
  snapshot_id: string;
  security_id: string | null;
  scheme_name: string;
  amc: string | null;
  folio_number: string | null;
  isin: string | null;
  plan_type: string | null;
  category: string | null;
  units: number;
  cost_value: number | null;
  current_value: number;
  latest_nav: number | null;
  latest_nav_date: string | null;
}

export interface CasDocumentRow {
  id: string;
  client_id: string;
  document_id: string;
  file_path: string;
  file_name?: string;
  statement_from_date: string | null;
  statement_to_date: string | null;
  valuation_date: string | null;
  uploaded_at: Date;
  parse_status: ParseStatus;
  parse_error: string | null;
  parse_warnings: string[];
  source: string;
  password_protected: boolean;
  notes: string | null;
  snapshot_id?: string | null;
  snapshot_review_status?: string | null;
}

export interface ReconciliationRunRow {
  id: string;
  client_id: string;
  client_name?: string;
  client_code?: string;
  previous_snapshot_id: string;
  current_snapshot_id: string;
  previous_snapshot_date?: string;
  current_snapshot_date?: string;
  status: "OPEN" | "COMPLETED" | "CANCELLED";
  previous_value: number;
  current_value: number;
  summary: Record<string, number>;
  engine_version: string;
  created_at: Date;
  completed_at: Date | null;
  open_matches?: number;
}

export interface ReconciliationMatchRow {
  id: string;
  run_id: string;
  client_id: string;
  advice_item_id: string | null;
  security_id: string | null;
  scheme_name: string;
  folio_numbers: string[];
  change_type: "INCREASE" | "DECREASE" | "NEW_HOLDING" | "EXITED";
  classification: "ADVICE_MATCH" | "SIP_INSTALMENT" | "UNADVISED";
  previous_units: number;
  current_units: number;
  detected_change: number;
  previous_value: number;
  current_value: number;
  approx_amount: number;
  reference_nav: number | null;
  expected_change: number | null;
  expected_amount: number | null;
  allocated_units: number | null;
  confidence: "HIGH" | "MEDIUM" | "LOW" | "NONE";
  status: MatchStatus;
  system_note: string | null;
  confirmed_units: number | null;
  confirmed_amount: number | null;
  execution_id: string | null;
  resolution_note: string | null;
  resolved_at: Date | null;
  reviewed_at: Date | null;
  cas_transaction_id: string | null;
  transaction_date: string | null;
  transaction_amount: number | null;
  transaction_units: number | null;
  transaction_nav: number | null;
  auto_confirmed: boolean;
  advice_action?: AdviceAction | null;
  advice_status?: AdviceStatus | null;
  advice_batch_code?: string | null;
  advice_communicated_at?: Date | null;
  advice_advised_amount?: number | null;
  advice_advised_units?: number | null;
}

export interface AuditLogRow {
  id: number;
  occurred_at: Date;
  actor_id: string | null;
  actor_name: string | null;
  actor_label: string | null;
  client_id: string | null;
  client_name?: string | null;
  entity_type: string;
  entity_id: string | null;
  action: string;
  changed_fields: string[] | null;
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  reason: string | null;
}

export interface NoteRow {
  id: string;
  client_id: string;
  note_type: string;
  body: string;
  advice_item_id: string | null;
  follow_up_date: string | null;
  follow_up_done_at: Date | null;
  created_at: Date;
  created_by: string | null;
  author_name: string | null;
}

export interface CommandCentreMetrics {
  day: string;
  total_clients: number;
  total_portfolio_value: number;
  active_plans: number;
  calls_issued_today: number;
  advice_items_today: number;
  sell_advised_today: number;
  buy_advised_today: number;
  executed_value_today: number;
  pending_value_total: number;
  pending_executions: number;
  partial_executions: number;
  stale_pending_executions: number;
  cas_mismatches: number;
  unadvised_activity: number;
  cas_needs_review: number;
  draft_plans: number;
  review_due: number;
  follow_ups_due: number;
}

export interface DocumentRow {
  id: string;
  client_id: string;
  document_type: string;
  file_path: string;
  file_name: string;
  mime_type: string | null;
  size_bytes: number | null;
  sha256: string;
  parse_status: string;
  parse_error: string | null;
  description: string | null;
  created_at: Date;
  uploader_name: string | null;
}
