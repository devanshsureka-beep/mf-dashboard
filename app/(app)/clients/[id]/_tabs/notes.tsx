import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { EmptyState } from "@/components/app/page-header";
import { Badge } from "@/components/ui/badge";
import { withUserTx, type Actor } from "@/lib/db/tx";
import { formatDate, formatDateTime } from "@/lib/format";
import { listNotes } from "@/services/notes";
import { addNoteAction, completeFollowUpAction } from "../actions";

export async function NotesTab({ clientId, actor }: { clientId: string; actor: Actor }) {
  const notes = await withUserTx(actor, (tx) => listNotes(tx, clientId));
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader><CardTitle>Notes ({notes.length})</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {notes.length === 0 ? <EmptyState title="No notes yet" /> : notes.map((n) => (
            <div key={n.id} className="border-b border-border pb-3 last:border-0">
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
                <Badge>{n.note_type}</Badge> {formatDateTime(n.created_at)} · {n.author_name}
                {n.follow_up_date ? (
                  n.follow_up_done_at ? <Badge tone="success">follow-up done</Badge> : <Badge tone="pending">follow-up {formatDate(n.follow_up_date)}</Badge>
                ) : null}
              </div>
              <div className="mt-1 whitespace-pre-wrap text-sm">{n.body}</div>
              {n.follow_up_date && !n.follow_up_done_at ? (
                <ActionForm action={completeFollowUpAction.bind(null, clientId, n.id)} className="mt-1">
                  <SubmitButton size="sm" variant="ghost">Mark follow-up done</SubmitButton>
                </ActionForm>
              ) : null}
            </div>
          ))}
        </CardContent>
      </Card>
      <Card id="add-note">
        <CardHeader><CardTitle>Add note</CardTitle></CardHeader>
        <CardContent>
          <ActionForm action={addNoteAction.bind(null, clientId)} className="space-y-3" resetOnSuccess>
            <Field label="Type">
              <Select name="note_type" defaultValue="GENERAL">
                <option value="GENERAL">General</option>
                <option value="CALL_LOG">Call log</option>
                <option value="FOLLOW_UP">Follow-up</option>
                <option value="REVIEW">Review</option>
                <option value="COMPLIANCE">Compliance</option>
              </Select>
            </Field>
            <Field label="Note"><Textarea name="body" rows={5} required /></Field>
            <Field label="Follow-up date (optional)"><Input name="follow_up_date" type="date" /></Field>
            <SubmitButton>Add note</SubmitButton>
          </ActionForm>
        </CardContent>
      </Card>
    </div>
  );
}
