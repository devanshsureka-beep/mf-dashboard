import type { Actor, Tx } from "@/lib/db/tx";
import { setAuditReason } from "@/lib/db/tx";
import { AppError } from "@/lib/errors";

/**
 * Everything kept about a premium client beyond the plan and calls:
 * agreements, premium payments, monthly report notes and a single timeline
 * of every recorded event since onboarding (for reviews and audits).
 */

export const AGREEMENT_TYPES = ["ADVISORY_AGREEMENT", "FEE_AGREEMENT", "RISK_PROFILE", "KYC", "CONSENT", "OTHER"] as const;
export const AGREEMENT_STATUSES = ["DRAFT", "SENT", "SIGNED", "EXPIRED", "TERMINATED"] as const;
export const PAYMENT_MODES = ["UPI", "NEFT", "RTGS", "IMPS", "CARD", "CHEQUE", "CASH", "OTHER"] as const;

export interface AgreementRow {
  id: string;
  agreement_type: (typeof AGREEMENT_TYPES)[number];
  title: string;
  reference_no: string | null;
  signed_on: string | null;
  valid_from: string | null;
  valid_to: string | null;
  status: (typeof AGREEMENT_STATUSES)[number];
  document_id: string | null;
  file_name: string | null;
  notes: string | null;
  created_at: Date;
  created_by_name: string | null;
}

export interface PaymentRow {
  id: string;
  amount: number;
  paid_on: string;
  period_from: string | null;
  period_to: string | null;
  plan_name: string;
  mode: (typeof PAYMENT_MODES)[number];
  reference: string | null;
  status: "RECEIVED" | "REFUNDED";
  notes: string | null;
  created_at: Date;
  created_by_name: string | null;
}

export interface PremiumSummary {
  premium_paid_total: number;
  premium_payments: number;
  last_paid_on: string | null;
  paid_until: string | null;
  premium_status: "ACTIVE" | "EXPIRED" | "PAID" | "UNPAID";
  renewal_due: boolean;
  agreements_signed: number;
  agreement_valid_to: string | null;
  agreement_status: "NONE" | "VALID" | "EXPIRED";
}

const iso = (d: string | null | undefined) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null);

export async function getPremium(tx: Tx, clientId: string): Promise<PremiumSummary> {
  const r = (await tx<PremiumSummary[]>`
    select premium_paid_total::float8 as premium_paid_total, premium_payments::int as premium_payments,
           last_paid_on::text as last_paid_on, paid_until::text as paid_until, premium_status, renewal_due,
           agreements_signed::int as agreements_signed, agreement_valid_to::text as agreement_valid_to, agreement_status
    from public.v_client_premium where client_id = ${clientId}`)[0];
  return r ?? {
    premium_paid_total: 0, premium_payments: 0, last_paid_on: null, paid_until: null, premium_status: "UNPAID",
    renewal_due: false, agreements_signed: 0, agreement_valid_to: null, agreement_status: "NONE",
  };
}

export async function listAgreements(tx: Tx, clientId: string): Promise<AgreementRow[]> {
  return tx<AgreementRow[]>`
    select a.id, a.agreement_type, a.title, a.reference_no, a.signed_on::text as signed_on, a.valid_from::text as valid_from,
           a.valid_to::text as valid_to, a.status, a.document_id, d.file_name, a.notes, a.created_at, p.full_name as created_by_name
    from public.client_agreements a
    left join public.documents d on d.id = a.document_id
    left join public.profiles p on p.id = a.created_by
    where a.client_id = ${clientId}
    order by coalesce(a.signed_on, a.created_at::date) desc, a.created_at desc`;
}

export interface AgreementInput {
  agreementType: string;
  title: string;
  referenceNo?: string | null;
  signedOn?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
  status?: string;
  documentId?: string | null;
  notes?: string | null;
}

export async function addAgreement(tx: Tx, actor: Actor, clientId: string, a: AgreementInput): Promise<string> {
  if (!(AGREEMENT_TYPES as readonly string[]).includes(a.agreementType)) throw new AppError("Choose the agreement type.");
  const status = a.status ?? "SIGNED";
  if (!(AGREEMENT_STATUSES as readonly string[]).includes(status)) throw new AppError("Invalid status.");
  if (!a.title.trim()) throw new AppError("Give the agreement a title.");
  if (status === "SIGNED" && !iso(a.signedOn)) throw new AppError("Enter the date it was signed.");
  const rows = await tx<{ id: string }[]>`
    insert into public.client_agreements (client_id, agreement_type, title, reference_no, signed_on, valid_from, valid_to, status, document_id, notes, created_by)
    values (${clientId}, ${a.agreementType}, ${a.title.trim()}, ${a.referenceNo || null}, ${iso(a.signedOn)}, ${iso(a.validFrom)},
            ${iso(a.validTo)}, ${status}, ${a.documentId ?? null}, ${a.notes || null}, ${actor.id})
    returning id`;
  return rows[0].id;
}

export async function setAgreementStatus(tx: Tx, id: string, status: string, reason: string): Promise<void> {
  if (!(AGREEMENT_STATUSES as readonly string[]).includes(status)) throw new AppError("Invalid status.");
  if (!reason.trim()) throw new AppError("A reason is required.");
  await setAuditReason(tx, reason);
  const res = await tx`
    update public.client_agreements set status = ${status},
      signed_on = case when ${status} = 'SIGNED' then coalesce(signed_on, app.today_ist()) else signed_on end,
      notes = coalesce(notes || E'\\n', '') || ${`${status}: ${reason}`}
    where id = ${id}`;
  if (res.count === 0) throw new AppError("Agreement not found.", "NOT_FOUND");
}

export async function listPayments(tx: Tx, clientId: string): Promise<PaymentRow[]> {
  const rows = await tx<PaymentRow[]>`
    select c.id, c.amount::float8 as amount, c.paid_on::text as paid_on, c.period_from::text as period_from, c.period_to::text as period_to,
           c.plan_name, c.mode, c.reference, c.status, c.notes, c.created_at, p.full_name as created_by_name
    from public.client_payments c left join public.profiles p on p.id = c.created_by
    where c.client_id = ${clientId}
    order by c.paid_on desc, c.created_at desc`;
  return rows;
}

export interface PaymentInput {
  amount: number;
  paidOn: string;
  periodFrom?: string | null;
  periodTo?: string | null;
  planName?: string | null;
  mode: string;
  reference?: string | null;
  notes?: string | null;
}

export async function addPayment(tx: Tx, actor: Actor, clientId: string, p: PaymentInput): Promise<string> {
  if (!(p.amount > 0)) throw new AppError("Enter the amount paid.");
  if (!iso(p.paidOn)) throw new AppError("Enter the payment date.");
  if (!(PAYMENT_MODES as readonly string[]).includes(p.mode)) throw new AppError("Choose the payment mode.");
  if (iso(p.periodFrom) && iso(p.periodTo) && (p.periodTo as string) < (p.periodFrom as string)) throw new AppError("The period ends before it starts.");
  const rows = await tx<{ id: string }[]>`
    insert into public.client_payments (client_id, amount, paid_on, period_from, period_to, plan_name, mode, reference, notes, created_by)
    values (${clientId}, ${p.amount}, ${p.paidOn}::date, ${iso(p.periodFrom)}, ${iso(p.periodTo)}, ${p.planName?.trim() || "MF Premium"},
            ${p.mode}, ${p.reference || null}, ${p.notes || null}, ${actor.id})
    returning id`;
  return rows[0].id;
}

/** Admin: mark a payment refunded (with a reason; the record stays). */
export async function refundPayment(tx: Tx, actor: Actor, id: string, reason: string): Promise<void> {
  if (actor.role !== "ADMIN") throw new AppError("Only an admin can change a recorded payment.", "FORBIDDEN");
  if (!reason.trim()) throw new AppError("A reason is required.");
  await setAuditReason(tx, `Admin correction: ${reason}`);
  const res = await tx`
    update public.client_payments set status = 'REFUNDED', notes = coalesce(notes || E'\\n', '') || ${`Refunded: ${reason}`}
    where id = ${id} and status = 'RECEIVED'`;
  if (res.count === 0) throw new AppError("Payment not found or already refunded.");
}

// -----------------------------------------------------------------------------
// Monthly report notes (advisor's words for the month)
// -----------------------------------------------------------------------------
export interface ReportNotes { summary: string | null; outlook: string | null; actions: string | null; updated_at: Date | null }

export async function getReportNotes(tx: Tx, clientId: string, month: string): Promise<ReportNotes> {
  const r = (await tx<ReportNotes[]>`
    select summary, outlook, actions, updated_at from public.client_report_notes
    where client_id = ${clientId} and report_month = ${month}::date`)[0];
  return r ?? { summary: null, outlook: null, actions: null, updated_at: null };
}

export async function saveReportNotes(tx: Tx, actor: Actor, clientId: string, month: string, n: { summary: string | null; outlook: string | null; actions: string | null }): Promise<void> {
  if (!/^\d{4}-\d{2}-01$/.test(month)) throw new AppError("Invalid report month.");
  const upd = await tx`
    update public.client_report_notes set summary = ${n.summary}, outlook = ${n.outlook}, actions = ${n.actions}
    where client_id = ${clientId} and report_month = ${month}::date`;
  if (upd.count === 0) {
    await tx`
      insert into public.client_report_notes (client_id, report_month, summary, outlook, actions, created_by)
      values (${clientId}, ${month}::date, ${n.summary}, ${n.outlook}, ${n.actions}, ${actor.id})`;
  }
}

// -----------------------------------------------------------------------------
// Timeline: every recorded event for the client, newest first.
// -----------------------------------------------------------------------------
export const TIMELINE_KINDS = ["ONBOARDING", "CAS", "PLAN", "CALL", "EXECUTION", "MATCHING", "SIP", "NOTE", "DOCUMENT", "AGREEMENT", "PAYMENT"] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

export interface TimelineEvent {
  at: Date;
  kind: TimelineKind;
  title: string;
  detail: string | null;
  amount: number | null;
  href: string | null;
  who: string | null;
}

export async function getTimeline(tx: Tx, clientId: string, opts: { kinds?: string[]; limit?: number } = {}): Promise<TimelineEvent[]> {
  const kinds = opts.kinds?.length ? opts.kinds : null;
  const rows = await tx<TimelineEvent[]>`
    select * from (
      select c.created_at as at, 'ONBOARDING' as kind, 'Client onboarded (' || c.client_code || ')' as title,
             concat_ws(' · ', 'Onboarding date ' || to_char(c.onboarding_date, 'DD-Mon-YYYY'), nullif(c.risk_profile, '')) as detail,
             null::numeric as amount, null::text as href, p.full_name as who
      from public.clients c left join public.profiles p on p.id = c.created_by where c.id = ${clientId}
      union all
      select s.created_at, 'CAS',
             (case when s.is_baseline then 'Onboarding CAS read' else 'CAS read' end) || ' · statement of ' || to_char(s.snapshot_date, 'DD-Mon-YYYY'),
             initcap(replace(s.review_status, '_', ' ')) || ' · ' || s.holdings_count || ' holding(s)',
             s.total_current_value, '/snapshots/' || s.id, p.full_name
      from public.portfolio_snapshots s left join public.profiles p on p.id = s.created_by where s.client_id = ${clientId}
      union all
      select pl.created_at, 'PLAN', 'Plan drafted: ' || pl.plan_name,
             initcap(pl.plan_kind) || ' plan · exit ' || to_char(pl.target_exit_value, 'FM99,99,99,99,990') || ' · buy ' || to_char(pl.target_buy_value, 'FM99,99,99,99,990'),
             null, '/clients/' || pl.client_id || '/plans/' || pl.id, p.full_name
      from public.advisory_plans pl left join public.profiles p on p.id = pl.created_by where pl.client_id = ${clientId}
      union all
      select pl.approved_at, 'PLAN', 'Plan approved: ' || pl.plan_name, 'Now ' || initcap(pl.status), null,
             '/clients/' || pl.client_id || '/plans/' || pl.id, p.full_name
      from public.advisory_plans pl left join public.profiles p on p.id = pl.approved_by
      where pl.client_id = ${clientId} and pl.approved_at is not null
      union all
      select b.communicated_at, 'CALL', ai.action || ' call · ' || ai.scheme_name,
             'Via ' || initcap(replace(b.communication_channel, '_', ' ')) || ' · ' || initcap(replace(ai.status, '_', ' '))
               || (case when ai.plan_item_id is null then ' · off-plan' else '' end),
             ai.advised_amount, '/advice/items/' || ai.id, p.full_name
      from public.advice_items ai join public.advice_batches b on b.id = ai.advice_batch_id
      left join public.profiles p on p.id = b.advisor_id where ai.client_id = ${clientId}
      union all
      select (e.execution_date::timestamp + time '12:00') at time zone 'Asia/Kolkata', 'EXECUTION', 'Executed · ' || ai.scheme_name,
             initcap(replace(e.verification_type, '_', ' ')) || (case when e.status not in ('EXECUTED', 'PARTIAL') then ' · ' || initcap(e.status) else '' end),
             e.executed_amount, '/advice/items/' || ai.id, p.full_name
      from public.executions e join public.advice_items ai on ai.id = e.advice_item_id
      left join public.profiles p on p.id = e.created_by where e.client_id = ${clientId}
      union all
      select r.created_at, 'MATCHING', 'CAS matched against calls',
             initcap(r.status) || coalesce(' · ' || (r.summary ->> 'unadvised') || ' unadvised', ''), null,
             '/reconciliation/' || r.id, p.full_name
      from public.reconciliation_runs r left join public.profiles p on p.id = r.created_by
      where r.client_id = ${clientId} and r.status <> 'CANCELLED'
      union all
      select coalesce(s.completed_at, s.advised_at), 'SIP', 'SIP ' || lower(s.action) || ' · ' || s.scheme_name,
             initcap(s.status) || coalesce(' · ₹' || to_char(coalesce(s.new_amount, s.old_amount), 'FM99,99,990') || '/' || lower(s.frequency), ''),
             null, '/clients/' || s.client_id || '/plans/' || s.plan_id, null
      from public.sip_plan_items s where s.client_id = ${clientId} and (s.advised_at is not null or s.completed_at is not null)
      union all
      select n.created_at, 'NOTE', initcap(replace(n.note_type, '_', ' ')) || ' note', left(n.body, 240), null, null, p.full_name
      from public.client_notes n left join public.profiles p on p.id = n.created_by
      where n.client_id = ${clientId} and n.deleted_at is null
      union all
      select d.created_at, 'DOCUMENT', initcap(replace(d.document_type, '_', ' ')) || ' uploaded', d.file_name, null,
             '/api/documents/' || d.id || '/download', p.full_name
      from public.documents d left join public.profiles p on p.id = d.created_by
      where d.client_id = ${clientId} and d.deleted_at is null and d.document_type <> 'CAS'
      union all
      select a.created_at, 'AGREEMENT', initcap(replace(a.agreement_type, '_', ' ')) || ' · ' || a.title,
             initcap(a.status) || coalesce(' · signed ' || to_char(a.signed_on, 'DD-Mon-YYYY'), '') || coalesce(' · valid till ' || to_char(a.valid_to, 'DD-Mon-YYYY'), ''),
             null, null, p.full_name
      from public.client_agreements a left join public.profiles p on p.id = a.created_by where a.client_id = ${clientId}
      union all
      select (cp.paid_on::timestamp + time '12:00') at time zone 'Asia/Kolkata', 'PAYMENT', 'Premium paid · ' || cp.plan_name,
             cp.mode || coalesce(' · ref ' || cp.reference, '') || coalesce(' · covers ' || to_char(cp.period_from, 'DD-Mon-YYYY') || ' – ' || to_char(cp.period_to, 'DD-Mon-YYYY'), '')
               || (case when cp.status = 'REFUNDED' then ' · REFUNDED' else '' end),
             cp.amount, null, p.full_name
      from public.client_payments cp left join public.profiles p on p.id = cp.created_by where cp.client_id = ${clientId}
    ) t
    where t.at is not null and (${kinds}::text[] is null or t.kind = any(${kinds}::text[]))
    order by t.at desc
    limit ${opts.limit ?? 500}`;
  return rows.map((r) => ({ ...r, amount: r.amount === null ? null : Number(r.amount) }));
}

// -----------------------------------------------------------------------------
// What needs attention on a client, for the header of the client page.
// -----------------------------------------------------------------------------
export interface ClientAlerts {
  unadvised: { runId: string; count: number; amount: number } | null;
  draftPlan: { id: string; name: string; kind: string } | null;
  followUpsDue: number;
  openCalls: number;
}

export async function getClientAlerts(tx: Tx, clientId: string): Promise<ClientAlerts> {
  const un = (await tx<{ run_id: string; n: number; amount: number }[]>`
    select m.run_id, count(*)::int as n, sum(m.approx_amount)::float8 as amount
    from public.reconciliation_matches m join public.reconciliation_runs r on r.id = m.run_id
    where m.client_id = ${clientId} and r.status <> 'CANCELLED' and m.classification = 'UNADVISED'
      and m.status in ('UNEXPLAINED', 'SUGGESTED') and m.reviewed_at is null
    group by m.run_id order by max(r.created_at) desc`);
  const draft = (await tx<{ id: string; plan_name: string; plan_kind: string }[]>`
    select id, plan_name, plan_kind from public.advisory_plans where client_id = ${clientId} and status = 'DRAFT'
    order by created_at desc limit 1`)[0];
  const fu = (await tx<{ n: number }[]>`
    select count(*)::int as n from public.client_notes
    where client_id = ${clientId} and deleted_at is null and follow_up_date is not null and follow_up_date <= app.today_ist()
      and follow_up_done_at is null`)[0];
  const calls = (await tx<{ n: number }[]>`select count(*)::int as n from public.v_advice_items where client_id = ${clientId} and is_open`)[0];
  return {
    unadvised: un.length ? { runId: un[0].run_id, count: un.reduce((t, r) => t + r.n, 0), amount: un.reduce((t, r) => t + r.amount, 0) } : null,
    draftPlan: draft ? { id: draft.id, name: draft.plan_name, kind: draft.plan_kind } : null,
    followUpsDue: fu?.n ?? 0,
    openCalls: calls?.n ?? 0,
  };
}
