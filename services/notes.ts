import type { Actor, Tx } from "@/lib/db/tx";
import { AppError } from "@/lib/errors";
import type { NoteRow } from "@/types/domain";

export async function listNotes(tx: Tx, clientId: string): Promise<NoteRow[]> {
  return tx<NoteRow[]>`
    select n.*, p.full_name as author_name
    from public.client_notes n left join public.profiles p on p.id = n.created_by
    where n.client_id = ${clientId} and n.deleted_at is null
    order by n.created_at desc`;
}

export async function addNote(
  tx: Tx,
  actor: Actor,
  input: { clientId: string; body: string; noteType?: string; followUpDate?: string | null; adviceItemId?: string | null },
): Promise<string> {
  if (!input.body.trim()) throw new AppError("Note cannot be empty.");
  const rows = await tx<{ id: string }[]>`
    insert into public.client_notes (client_id, note_type, body, follow_up_date, advice_item_id, created_by)
    values (${input.clientId}, ${input.noteType ?? "GENERAL"}, ${input.body.trim()}, ${input.followUpDate || null},
            ${input.adviceItemId || null}, ${actor.id})
    returning id`;
  return rows[0].id;
}

export async function completeFollowUp(tx: Tx, noteId: string): Promise<void> {
  const res = await tx`update public.client_notes set follow_up_done_at = now() where id = ${noteId} and follow_up_done_at is null`;
  if (res.count === 0) throw new AppError("Follow-up not found or already done.");
}

export async function listDueFollowUps(tx: Tx, limit = 20) {
  return tx<(NoteRow & { client_name: string; client_code: string })[]>`
    select n.*, p.full_name as author_name, c.full_name as client_name, c.client_code
    from public.client_notes n
    join public.clients c on c.id = n.client_id
    left join public.profiles p on p.id = n.created_by
    where n.deleted_at is null and n.follow_up_done_at is null and n.follow_up_date is not null
      and n.follow_up_date <= app.today_ist()
    order by n.follow_up_date limit ${limit}`;
}
