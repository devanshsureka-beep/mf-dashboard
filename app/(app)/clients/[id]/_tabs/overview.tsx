import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Select, Input } from "@/components/ui/form";
import { AdviceTable } from "@/components/app/advice-table";
import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { ClientFields } from "@/components/app/client-form";
import { EmptyState } from "@/components/app/page-header";
import { withUserTx, type Actor } from "@/lib/db/tx";
import { formatDateTime, formatINRCompact } from "@/lib/format";
import { listAdviceLedger } from "@/services/advice";
import { listAdvisors } from "@/services/clients";
import { getTimeline } from "@/services/client-record";
import { listNotes } from "@/services/notes";
import type { ClientSummary } from "@/types/domain";
import { reassignAdvisorAction, updateClientAction } from "../../actions";

export async function OverviewTab({ client: c, actor }: { client: ClientSummary; actor: Actor }) {
  const data = await withUserTx(actor, async (tx) => ({
    open: await listAdviceLedger(tx, { clientId: c.client_id, status: "OPEN" }),
    activity: await getTimeline(tx, c.client_id, { limit: 10 }),
    notes: (await listNotes(tx, c.client_id)).slice(0, 4),
    advisors: actor.role === "ADMIN" ? await listAdvisors(tx) : [],
  }));
  const canAdvise = actor.role !== "OPERATIONS";

  return (
    <div className="grid gap-3 xl:grid-cols-3">
      <div className="space-y-3 xl:col-span-2">
        <Card>
          <CardHeader><CardTitle>Open calls awaiting execution ({data.open.length})</CardTitle></CardHeader>
          {data.open.length ? <AdviceTable rows={data.open} showClient={false} compact /> : <CardContent><EmptyState title="No open calls" /></CardContent>}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
            <Link className="text-xs text-brand hover:underline" href={`/clients/${c.client_id}?tab=timeline`}>Full timeline →</Link>
          </CardHeader>
          {data.activity.length ? (
            <ol className="divide-y divide-border">
              {data.activity.map((e, i) => (
                <li key={i} className="flex items-baseline gap-3 px-4 py-2 text-sm">
                  <span className="w-28 shrink-0 text-[11px] text-muted">{formatDateTime(e.at)}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {e.href ? <Link href={e.href} className="font-medium hover:underline">{e.title}</Link> : <span className="font-medium">{e.title}</span>}
                    {e.detail ? <span className="text-muted"> · {e.detail}</span> : null}
                  </span>
                  {e.amount !== null ? <span className="shrink-0 font-medium">{formatINRCompact(e.amount)}</span> : null}
                </li>
              ))}
            </ol>
          ) : <CardContent><EmptyState title="Nothing recorded yet" /></CardContent>}
        </Card>
      </div>

      <div className="space-y-3">
        <Card>
          <CardHeader>
            <CardTitle>Recent notes</CardTitle>
            <Link className="text-xs text-brand hover:underline" href={`/clients/${c.client_id}?tab=notes`}>All notes →</Link>
          </CardHeader>
          <CardContent className="space-y-3">
            {data.notes.length === 0 ? <p className="text-sm text-muted">No notes yet.</p> : data.notes.map((n) => (
              <div key={n.id} className="text-sm">
                <div className="text-[11px] text-muted">{formatDateTime(n.created_at)} · {n.author_name} · {n.note_type}</div>
                <div className="whitespace-pre-wrap">{n.body}</div>
              </div>
            ))}
          </CardContent>
        </Card>

        {canAdvise ? (
          <Card>
            <CardHeader><CardTitle>Client details</CardTitle></CardHeader>
            <CardContent>
              <details>
                <summary className="cursor-pointer text-sm text-brand">Edit details</summary>
                <ActionForm action={updateClientAction.bind(null, c.client_id)} className="mt-3 space-y-3">
                  <ClientFields client={c} />
                  <SubmitButton size="sm">Save details</SubmitButton>
                </ActionForm>
              </details>
            </CardContent>
          </Card>
        ) : null}

        {actor.role === "ADMIN" ? (
          <Card>
            <CardHeader><CardTitle>Advisor assignment</CardTitle></CardHeader>
            <CardContent>
              <ActionForm action={reassignAdvisorAction.bind(null, c.client_id)} className="space-y-2">
                <Field label="Primary advisor">
                  <Select name="advisor_id" defaultValue={c.advisor_id ?? ""}>
                    {data.advisors.map((a) => <option key={a.id} value={a.id}>{a.full_name}</option>)}
                  </Select>
                </Field>
                <Input name="reason" placeholder="Reason for change" />
                <SubmitButton size="sm" variant="outline">Reassign</SubmitButton>
              </ActionForm>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
