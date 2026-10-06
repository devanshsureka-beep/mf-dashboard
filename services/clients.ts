import type { Actor, Tx } from "@/lib/db/tx";
import { AppError } from "@/lib/errors";
import type { ClientSummary } from "@/types/domain";

export interface ClientFilters {
  q?: string;
  advisorId?: string;
  status?: string;
  attention?: "pending" | "unadvised" | "no_plan";
}

export async function listClientSummaries(tx: Tx, f: ClientFilters = {}): Promise<ClientSummary[]> {
  const q = f.q?.trim() ? `%${f.q.trim()}%` : null;
  return tx<ClientSummary[]>`
    select * from public.v_client_summary
    where (${q}::text is null or full_name ilike ${q} or client_code ilike ${q} or email ilike ${q} or pan ilike ${q})
      and (${f.advisorId ?? null}::uuid is null or advisor_id = ${f.advisorId ?? null})
      and (${f.status ?? null}::text is null or status = ${f.status ?? null})
      and (${f.attention ?? null}::text is null
           or (${f.attention ?? null} = 'pending' and pending_total > 0)
           or (${f.attention ?? null} = 'unadvised' and unadvised_count > 0)
           or (${f.attention ?? null} = 'no_plan' and active_plan_id is null))
    order by full_name
  `;
}

export async function getClientSummary(tx: Tx, clientId: string): Promise<ClientSummary> {
  const rows = await tx<ClientSummary[]>`select * from public.v_client_summary where client_id = ${clientId}`;
  if (!rows[0]) throw new AppError("Client not found or you do not have access.", "NOT_FOUND");
  return rows[0];
}

export interface CreateClientInput {
  full_name: string;
  email?: string | null;
  phone?: string | null;
  pan?: string | null;
  onboarding_date?: string | null;
  risk_profile?: string | null;
  goal?: string | null;
  status?: string;
  next_review_date?: string | null;
  advisor_id?: string | null;
}

export async function createClient(tx: Tx, actor: Actor, input: CreateClientInput): Promise<{ id: string; client_code: string }> {
  const advisorId = actor.role === "ADVISOR" ? actor.id : input.advisor_id;
  if (!advisorId) throw new AppError("Choose the primary advisor for this client.");
  const rows = await tx<{ id: string; client_code: string }[]>`
    insert into public.clients (full_name, email, phone, pan, onboarding_date, risk_profile, goal, status, next_review_date, created_by)
    values (${input.full_name}, ${input.email || null}, ${input.phone || null}, ${input.pan?.toUpperCase() || null},
            coalesce(${input.onboarding_date || null}::date, app.today_ist()), ${input.risk_profile || null},
            ${input.goal || null}, ${input.status ?? "ONBOARDING"}, ${input.next_review_date || null}, ${actor.id})
    returning id, client_code`;
  const client = rows[0];
  await tx`
    insert into public.client_advisor_assignments (client_id, advisor_id, assignment_role, created_by)
    values (${client.id}, ${advisorId}, 'PRIMARY', ${actor.id})`;
  return client;
}

export async function updateClient(tx: Tx, clientId: string, input: Omit<CreateClientInput, "advisor_id">): Promise<void> {
  const res = await tx`
    update public.clients set
      full_name = ${input.full_name}, email = ${input.email || null}, phone = ${input.phone || null},
      pan = ${input.pan?.toUpperCase() || null}, risk_profile = ${input.risk_profile || null},
      goal = ${input.goal || null}, status = ${input.status ?? "ACTIVE"},
      next_review_date = ${input.next_review_date || null}
    where id = ${clientId}`;
  if (res.count === 0) throw new AppError("Client not found or you cannot edit it.", "NOT_FOUND");
}

/** Admin only (RLS): change the primary advisor. Old assignment is closed, never deleted. */
export async function reassignPrimaryAdvisor(tx: Tx, actor: Actor, clientId: string, advisorId: string): Promise<void> {
  await tx`
    update public.client_advisor_assignments
       set is_active = false, unassigned_at = now()
     where client_id = ${clientId} and is_active and (assignment_role = 'PRIMARY' or advisor_id = ${advisorId})`;
  await tx`
    insert into public.client_advisor_assignments (client_id, advisor_id, assignment_role, created_by)
    values (${clientId}, ${advisorId}, 'PRIMARY', ${actor.id})`;
}

export async function listAdvisors(tx: Tx): Promise<{ id: string; full_name: string; role: string }[]> {
  return tx<{ id: string; full_name: string; role: string }[]>`
    select id, full_name, role from public.profiles
    where is_active and role in ('ADVISOR', 'ADMIN')
    order by full_name`;
}

// -----------------------------------------------------------------------------
// The client list of the advisory desk: plan numbers plus premium, agreement,
// SIP and what needs attention, with filters and sorting.
// -----------------------------------------------------------------------------
export interface DeskFilters {
  q?: string;
  advisorId?: string;
  status?: string;
  risk?: string;
  plan?: "active" | "draft" | "none";
  premium?: "active" | "renewal_due" | "expired" | "unpaid";
  agreement?: "valid" | "missing";
  attention?: "pending" | "unadvised" | "cas_review" | "follow_up" | "no_plan";
  minValue?: number | null;
  maxValue?: number | null;
  sort?: "name" | "value" | "pending" | "onboarded" | "renewal" | "code";
}

export type DeskClient = ClientSummary & {
  premium_paid_total: number;
  paid_until: string | null;
  premium_status: string;
  renewal_due: boolean;
  agreement_status: string;
  agreement_valid_to: string | null;
  sip_monthly_target: number;
  sip_invested: number;
  unadvised_to_review: number;
  cas_to_review: number;
  follow_ups_due: number;
  has_draft_plan: boolean;
};

export async function listDeskClients(tx: Tx, f: DeskFilters = {}): Promise<DeskClient[]> {
  const q = f.q?.trim() ? `%${f.q.trim()}%` : null;
  const rows = await tx<DeskClient[]>`
    select s.*, p.premium_paid_total::float8 as premium_paid_total, p.paid_until::text as paid_until, p.premium_status, p.renewal_due,
           p.agreement_status, p.agreement_valid_to::text as agreement_valid_to,
           coalesce(sp.sip_monthly_target, 0)::float8 as sip_monthly_target, coalesce(sp.sip_invested, 0)::float8 as sip_invested,
           coalesce(un.n, 0)::int as unadvised_to_review, coalesce(cr.n, 0)::int as cas_to_review, coalesce(fu.n, 0)::int as follow_ups_due,
           exists (select 1 from public.advisory_plans d where d.client_id = s.client_id and d.status = 'DRAFT') as has_draft_plan
    from public.v_client_summary s
    left join public.v_client_premium p on p.client_id = s.client_id
    left join public.v_client_sip sp on sp.client_id = s.client_id
    left join lateral (
      select count(*) as n from public.reconciliation_matches m join public.reconciliation_runs r on r.id = m.run_id
      where m.client_id = s.client_id and r.status <> 'CANCELLED' and m.classification = 'UNADVISED'
        and m.status in ('UNEXPLAINED', 'SUGGESTED') and m.reviewed_at is null) un on true
    left join lateral (
      select count(*) as n from public.portfolio_snapshots ps where ps.client_id = s.client_id and ps.review_status = 'PENDING_REVIEW') cr on true
    left join lateral (
      select count(*) as n from public.client_notes n where n.client_id = s.client_id and n.deleted_at is null
        and n.follow_up_date <= app.today_ist() and n.follow_up_done_at is null) fu on true
    where (${q}::text is null or s.full_name ilike ${q} or s.client_code ilike ${q} or s.email ilike ${q} or s.pan ilike ${q} or s.phone ilike ${q})
      and (${f.advisorId ?? null}::uuid is null or s.advisor_id = ${f.advisorId ?? null})
      and (${f.status ?? null}::text is null or s.status = ${f.status ?? null})
      and (${f.risk ?? null}::text is null or s.risk_profile = ${f.risk ?? null})
      and (${f.minValue ?? null}::numeric is null or coalesce(s.live_portfolio_value, 0) >= ${f.minValue ?? null})
      and (${f.maxValue ?? null}::numeric is null or coalesce(s.live_portfolio_value, 0) <= ${f.maxValue ?? null})`;
  let out = rows.map((r) => ({
    ...r,
    premium_paid_total: Number(r.premium_paid_total ?? 0),
    premium_status: r.premium_status ?? "UNPAID",
    agreement_status: r.agreement_status ?? "NONE",
    renewal_due: Boolean(r.renewal_due),
  }));
  if (f.plan) out = out.filter((c) => (f.plan === "active" ? Boolean(c.active_plan_id) : f.plan === "draft" ? c.has_draft_plan : !c.active_plan_id));
  if (f.premium) {
    out = out.filter((c) => (f.premium === "renewal_due" ? c.renewal_due
      : f.premium === "active" ? c.premium_status === "ACTIVE"
      : f.premium === "expired" ? c.premium_status === "EXPIRED"
      : c.premium_status === "UNPAID" || c.premium_status === "PAID"));
  }
  if (f.agreement) out = out.filter((c) => (f.agreement === "valid" ? c.agreement_status === "VALID" : c.agreement_status !== "VALID"));
  if (f.attention) {
    out = out.filter((c) => (f.attention === "pending" ? c.pending_total > 0
      : f.attention === "unadvised" ? c.unadvised_to_review > 0
      : f.attention === "cas_review" ? c.cas_to_review > 0
      : f.attention === "follow_up" ? c.follow_ups_due > 0
      : !c.active_plan_id));
  }
  const by: Record<NonNullable<DeskFilters["sort"]>, (a: DeskClient, b: DeskClient) => number> = {
    name: (a, b) => a.full_name.localeCompare(b.full_name),
    code: (a, b) => a.client_code.localeCompare(b.client_code),
    value: (a, b) => (b.live_portfolio_value ?? 0) - (a.live_portfolio_value ?? 0),
    pending: (a, b) => b.pending_total - a.pending_total,
    onboarded: (a, b) => b.onboarding_date.localeCompare(a.onboarding_date),
    renewal: (a, b) => (a.paid_until ?? "9999").localeCompare(b.paid_until ?? "9999"),
  };
  return out.sort(by[f.sort ?? "name"]);
}
