import type { Actor, Tx } from "@/lib/db/tx";
import { setAuditReason } from "@/lib/db/tx";
import { AppError } from "@/lib/errors";

/**
 * Admin: delete (and restore) clients, several at a time. Nothing is erased:
 * a deleted client and everything under it is hidden from every screen and
 * user (the database enforces it), the PAN is freed for a clean re-onboarding,
 * and an admin can restore it. The reason is kept on the client and in the
 * audit log.
 */

export interface DeletedClient {
  id: string;
  client_code: string;
  full_name: string;
  pan: string | null;
  deleted_at: Date;
  deleted_reason: string | null;
  deleted_by_name: string | null;
}

const isAdmin = (actor: Actor) => {
  if (actor.role !== "ADMIN") throw new AppError("Only an admin can delete or restore clients.", "FORBIDDEN");
};

const cleanIds = (ids: string[]) => [...new Set(ids.filter((x) => /^[0-9a-f-]{36}$/i.test(x)))].slice(0, 500);

export async function deleteClients(tx: Tx, actor: Actor, ids: string[], reason: string): Promise<number> {
  isAdmin(actor);
  const list = cleanIds(ids);
  if (!list.length) throw new AppError("Select at least one client.");
  if (!reason.trim()) throw new AppError("A reason is required to delete clients.");
  await setAuditReason(tx, `Client deleted: ${reason.trim()}`);
  const res = await tx`
    update public.clients set deleted_at = now(), deleted_by = ${actor.id}, deleted_reason = ${reason.trim()}
    where id = any(${list}::uuid[]) and deleted_at is null`;
  return res.count;
}

export async function restoreClients(tx: Tx, actor: Actor, ids: string[], reason: string): Promise<number> {
  isAdmin(actor);
  const list = cleanIds(ids);
  if (!list.length) throw new AppError("Select at least one client.");
  if (!reason.trim()) throw new AppError("A reason is required to restore clients.");
  // A live client with the same PAN (e.g. re-onboarded since) blocks the restore.
  const clash = await tx<{ full_name: string; client_code: string; pan: string }[]>`
    select d.full_name, d.client_code, d.pan from public.clients d
    where d.id = any(${list}::uuid[]) and d.deleted_at is not null and d.pan is not null
      and exists (select 1 from public.clients l where l.pan = d.pan and l.deleted_at is null)`;
  if (clash.length) {
    throw new AppError(`${clash.map((c) => `${c.full_name} (${c.client_code})`).join(", ")}: another live client already has this PAN. Delete or merge that one first.`, "CONFLICT");
  }
  await setAuditReason(tx, `Client restored: ${reason.trim()}`);
  const res = await tx`
    update public.clients set deleted_at = null, deleted_by = null, deleted_reason = null
    where id = any(${list}::uuid[]) and deleted_at is not null`;
  return res.count;
}

export async function listDeletedClients(tx: Tx): Promise<DeletedClient[]> {
  return tx<DeletedClient[]>`
    select c.id, c.client_code, c.full_name, c.pan, c.deleted_at, c.deleted_reason, p.full_name as deleted_by_name
    from public.clients c left join public.profiles p on p.id = c.deleted_by
    where c.deleted_at is not null
    order by c.deleted_at desc`;
}
