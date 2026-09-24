import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Select, Input } from "@/components/ui/form";
import { AdviceTable } from "@/components/app/advice-table";
import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { ClientFields } from "@/components/app/client-form";
import { SipTable } from "@/components/app/sip-table";
import { StatCard } from "@/components/app/stat-card";
import { EmptyState } from "@/components/app/page-header";
import { withUserTx, type Actor } from "@/lib/db/tx";
import { formatDateTime, formatINRCompact } from "@/lib/format";
import { listAdviceLedger } from "@/services/advice";
import { listAdvisors } from "@/services/clients";
import { getSipItems } from "@/services/plans";
import { listNotes } from "@/services/notes";
import type { ClientSummary } from "@/types/domain";
import { reassignAdvisorAction, updateClientAction } from "../../actions";
import { setSipStatusAction } from "../actions";

export async function OverviewTab({ client: c, actor }: { client: ClientSummary; actor: Actor }) {
  const data = await withUserTx(actor, async (tx) => ({
    open: await listAdviceLedger(tx, { clientId: c.client_id, status: "OPEN" }),
    sips: c.active_plan_id ? await getSipItems(tx, c.active_plan_id) : [],
    notes: (await listNotes(tx, c.client_id)).slice(0, 4),
    advisors: actor.role === "ADMIN" ? await listAdvisors(tx) : [],
  }));
  const sip = {
    toStop: data.sips.filter((s) => s.action === "STOP" && s.status !== "CANCELLED"),
    toStart: data.sips.filter((s) => s.action !== "STOP" && s.status !== "CANCELLED"),
  };
  const canAdvise = actor.role !== "OPERATIONS";

  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <div className="space-y-4 xl:col-span-2">
        <Card>
          <CardHeader><CardTitle>Open calls awaiting execution ({data.open.length})</CardTitle></CardHeader>
          {data.open.length ? <AdviceTable rows={data.open} showClient={false} compact /> : <CardContent><EmptyState title="No open calls" /></CardContent>}
        </Card>

        <Card>
          <CardHeader><CardTitle>SIP transition</CardTitle></CardHeader>
          <CardContent>
            <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
              <StatCard label="SIPs to stop" value={sip.toStop.length} hint={formatINRCompact(sip.toStop.reduce((s, x) => s + (x.old_amount ?? 0), 0)) + "/mo"} />
              <StatCard label="SIPs stopped" value={sip.toStop.filter((s) => s.status === "COMPLETED").length} tone="success" />
              <StatCard label="SIPs to start" value={sip.toStart.length} hint={formatINRCompact(sip.toStart.reduce((s, x) => s + (x.new_amount ?? 0), 0)) + "/mo"} />
              <StatCard label="SIPs started" value={sip.toStart.filter((s) => s.status === "COMPLETED").length} tone="success" />
              <StatCard label="Pending SIP actions" value={data.sips.filter((s) => s.status === "PLANNED" || s.status === "ADVISED").length} tone="attention" />
            </div>
            {data.sips.length ? (
              <SipTable rows={data.sips} canUpdate action={setSipStatusAction.bind(null, c.client_id)} />
            ) : (
              <p className="text-sm text-muted">No SIP actions in the active plan.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="space-y-4">
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
