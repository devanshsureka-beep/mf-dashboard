/**
 * Team membership. Removing someone keeps their profile (calls, plans and the
 * audit log point at it) but takes away sign-in and data access; adding them
 * back restores it. Sign-in itself is blocked in Supabase Auth by the caller.
 */
import { AppError } from "@/lib/errors";
import { setAuditReason, type Actor, type Tx } from "@/lib/db/tx";
import type { AppRole } from "@/types/domain";

export async function removeTeamMember(tx: Tx, actor: Actor, userId: string, reason: string): Promise<{ email: string; fullName: string }> {
  if (actor.role !== "ADMIN") throw new AppError("Only an admin can remove team members.", "FORBIDDEN");
  if (actor.id === userId) throw new AppError("You cannot remove yourself.");
  if (!reason.trim()) throw new AppError("Give a reason (kept in the audit log).");
  const [p] = await tx<{ email: string; full_name: string; role: string; removed_at: Date | null }[]>`
    select email, full_name, role, removed_at from public.profiles where id = ${userId}`;
  if (!p) throw new AppError("User not found.", "NOT_FOUND");
  if (p.removed_at) throw new AppError(`${p.full_name || p.email} is already removed.`);
  if (p.role === "ADMIN") {
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from public.profiles where role = 'ADMIN' and is_active and id <> ${userId}`;
    if (n === 0) throw new AppError("This is the last active admin; make someone else an admin first.");
  }
  // Clients need a main advisor: move them first.
  const primary = await tx<{ full_name: string }[]>`
    select c.full_name from public.client_advisor_assignments a join public.clients c on c.id = a.client_id
    where a.advisor_id = ${userId} and a.is_active and a.assignment_role = 'PRIMARY' and c.deleted_at is null
    order by c.full_name`;
  if (primary.length) {
    const names = primary.slice(0, 5).map((c) => c.full_name).join(", ");
    throw new AppError(`${p.full_name || p.email} is the main advisor of ${primary.length} client(s) (${names}${primary.length > 5 ? ", …" : ""}). Change their advisor on each client page first, then remove.`);
  }
  await setAuditReason(tx, `Removed from the team: ${reason.trim()}`);
  await tx`
    update public.client_advisor_assignments set is_active = false, unassigned_at = now()
    where advisor_id = ${userId} and is_active`;
  await tx`update public.profiles set is_active = false, removed_at = now(), removed_by = ${actor.id} where id = ${userId}`;
  return { email: p.email, fullName: p.full_name };
}

export async function restoreTeamMember(tx: Tx, actor: Actor, userId: string, args: { role: AppRole; fullName?: string | null }): Promise<void> {
  if (actor.role !== "ADMIN") throw new AppError("Only an admin can add team members.", "FORBIDDEN");
  await setAuditReason(tx, "Added back to the team by admin");
  const rows = await tx`
    update public.profiles set role = ${args.role}, is_active = true, removed_at = null, removed_by = null,
      full_name = coalesce(nullif(${args.fullName ?? ""}, ''), full_name)
    where id = ${userId} returning id`;
  if (!rows.length) throw new AppError("User not found.", "NOT_FOUND");
}

/** A profile with this email (any state), to add an existing account back instead of failing. */
export async function findProfileByEmail(tx: Tx, email: string): Promise<{ id: string; removed: boolean; active: boolean } | null> {
  const [p] = await tx<{ id: string; removed_at: Date | null; is_active: boolean }[]>`
    select id, removed_at, is_active from public.profiles where lower(email) = lower(${email.trim()})`;
  return p ? { id: p.id, removed: p.removed_at !== null, active: p.is_active } : null;
}
