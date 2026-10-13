import { Input, Select } from "@/components/ui/form";
import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { withUserTx, type Actor } from "@/lib/db/tx";
import { formatDate, formatDateTime, humanize } from "@/lib/format";
import { listNotes } from "@/services/notes";
import { addNoteAction, completeFollowUpAction } from "../actions";

/** Notes & follow-ups: a one-line add form on top, the notes below. */
export async function NotesPanel({ clientId, actor }: { clientId: string; actor: Actor }) {
  const notes = await withUserTx(actor, (tx) => listNotes(tx, clientId));
  return (
    <section id="notes" className="scroll-mt-14 overflow-hidden rounded-xl border border-border bg-surface">
      <div className="px-4 pt-3 text-sm font-semibold">Notes &amp; follow-ups · {notes.length}</div>
      <ActionForm action={addNoteAction.bind(null, clientId)} className="px-4 pb-3 pt-2" resetOnSuccess>
        <div id="add-note" className="grid scroll-mt-14 gap-2 sm:grid-cols-[140px_minmax(0,1fr)_160px_auto]">
          <Select name="note_type" defaultValue="GENERAL" aria-label="Note type">
            <option value="GENERAL">General</option>
            <option value="CALL_LOG">Call log</option>
            <option value="FOLLOW_UP">Follow-up</option>
            <option value="REVIEW">Review</option>
            <option value="COMPLIANCE">Compliance</option>
          </Select>
          <Input name="body" placeholder="Write a note…" required aria-label="Note" />
          <Input name="follow_up_date" type="date" aria-label="Follow-up date (optional)" title="Follow-up date (optional)" />
          <SubmitButton size="sm">Add</SubmitButton>
        </div>
      </ActionForm>
      {notes.length === 0 ? <p className="border-t border-border px-4 py-3 text-sm text-muted">No notes yet.</p> : (
        <ul className="divide-y divide-border border-t border-border">
          {notes.map((n) => (
            <li key={n.id} className="px-4 py-2.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted">
                <b className="text-slate-700">{humanize(n.note_type)}</b> · {formatDateTime(n.created_at)} · {n.author_name}
                {n.follow_up_date ? (
                  n.follow_up_done_at
                    ? <span className="rounded-full bg-emerald-50 px-2 text-emerald-800">follow-up done</span>
                    : <span className="rounded-full bg-amber-50 px-2 text-amber-900">follow-up {formatDate(n.follow_up_date)}</span>
                ) : null}
                {n.follow_up_date && !n.follow_up_done_at ? (
                  <ActionForm action={completeFollowUpAction.bind(null, clientId, n.id)} className="inline">
                    <SubmitButton size="sm" variant="ghost">Mark done</SubmitButton>
                  </ActionForm>
                ) : null}
              </div>
              <div className="mt-0.5 whitespace-pre-wrap text-sm">{n.body}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
