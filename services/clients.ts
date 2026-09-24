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
