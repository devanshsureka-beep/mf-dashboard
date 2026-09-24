import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { ExecutionsTable } from "@/components/app/executions-table";
import { Money } from "@/components/app/money";
import { ActionBadge, StatusBadge } from "@/components/app/status-badge";
import { StatCard } from "@/components/app/stat-card";
import { RecordExecutionForm } from "@/components/app/record-execution-form";
import { EmptyState } from "@/components/app/page-header";
import { TransitionBar } from "@/components/ui/progress";
import { formatDate, formatDateTime, formatINR, formatUnits, humanize, toISTDateTimeLocal } from "@/lib/format";
import { pageData } from "@/lib/server";
import { getAdviceItem, getExecutionsForAdvice, getRevisionChain } from "@/services/advice";
import { CHANNELS } from "@/types/domain";
import { closeAdviceAction, followUpNoteAction, reviseAdviceAction } from "../../actions";
import { confirmPendingExecutionAction, recordExecutionAction, voidExecutionAction } from "../../../executions/actions";

export const metadata = { title: "Call detail" };

export default async function AdviceItemPage(props: PageProps<"/advice/items/[itemId]">) {
  const { itemId } = await props.params;
  const { a, chain, executions, notes, actor } = await pageData(async (tx) => ({
    a: await getAdviceItem(tx, itemId),
    chain: await getRevisionChain(tx, itemId),
    executions: await getExecutionsForAdvice(tx, itemId),
    notes: await tx<{ id: string; body: string; created_at: Date; follow_up_date: string | null; author: string | null }[]>`
      select n.id, n.body, n.created_at, n.follow_up_date, p.full_name as author
      from public.client_notes n left join public.profiles p on p.id = n.created_by
      where n.advice_item_id = ${itemId} and n.deleted_at is null order by n.created_at desc`,
  }));
  const canAdvise = actor.role !== "OPERATIONS";

  return (
    <>
      <div className="mb-4">
        <div className="text-xs text-muted">
          <Link href="/advice" className="hover:underline">Call ledger</Link> / <span className="num">{a.batch_code}</span>
        </div>
        <h1 className="mt-0.5 flex flex-wrap items-center gap-2 text-xl font-semibold">
          <ActionBadge action={a.action} /> {a.scheme_name} <StatusBadge status={a.status} />
        </h1>
        <div className="mt-1 flex flex-wrap gap-x-4 text-sm text-muted">
          <span>Client <Link className="text-ink hover:underline" href={`/clients/${a.client_id}`}>{a.client_name}</Link> ({a.client_code})</span>
          <span>Advisor <span className="text-ink">{a.advisor_name}</span></span>
          <span>Communicated <span className="text-ink">{formatDateTime(a.communicated_at)}</span> via {humanize(a.communication_channel)}</span>
          <span>Recorded {formatDateTime(a.created_at)}</span>
          <span>{a.plan_item_id ? "Linked to plan item" : "Off-plan call"}</span>
          <span>Age {a.age_days} day(s)</span>
        </div>
        {a.status_reason && a.status !== "ISSUED" ? <p className="mt-1 text-sm">Status reason: <span className="text-muted">{a.status_reason}</span></p> : null}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={a.quantity_basis === "UNITS" ? "Advised (estimate)" : "Advised"} value={formatINR(a.advised_amount)} hint={a.advised_units ? `${formatUnits(a.advised_units)} units · basis ${a.quantity_basis}` : `basis ${a.quantity_basis}`} />
        <StatCard label="Executed" value={formatINR(a.executed_amount)} hint={a.executed_units ? `${formatUnits(a.executed_units)} units · ${a.execution_count} execution(s)` : `${a.execution_count} execution(s)`} tone="success" />
        <StatCard label="Pending execution" value={formatINR(a.pending_amount)} hint={a.pending_units ? `${formatUnits(a.pending_units)} units` : undefined} tone={a.pending_amount > 0 ? "attention" : "default"} />
        <StatCard label="Counted as advised" value={formatINR(a.effective_advised_amount)} hint="= executed + pending (used in plan totals)" />
      </div>
      <TransitionBar className="mt-3" target={a.effective_advised_amount || a.advised_amount} executed={a.executed_amount} pending={a.pending_amount} />

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Card>
            <CardHeader><CardTitle>Executions against this call</CardTitle></CardHeader>
            {executions.length ? <ExecutionsTable rows={executions} showClient={false} showSecurity={false} /> : <CardContent><EmptyState title="No executions recorded yet" /></CardContent>}
            {executions.some((e) => e.status === "EXECUTED" || e.status === "PARTIAL" || e.status === "PENDING") ? (
              <CardContent className="space-y-2 border-t border-border">
                {executions.filter((e) => !["REJECTED", "CANCELLED"].includes(e.status)).map((e) => (
                  <div key={e.id} className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="w-56 text-muted">{formatDate(e.execution_date)} · <Money value={e.executed_amount} full /></span>
                    {e.status === "PENDING" ? (
                      <ActionForm action={confirmPendingExecutionAction.bind(null, itemId, e.id)}><SubmitButton size="sm" variant="outline">Confirm executed</SubmitButton></ActionForm>
                    ) : null}
                    <ActionForm action={voidExecutionAction.bind(null, itemId, e.id)} className="flex items-center gap-1">
                      <Select name="status" className="h-8 w-28 text-xs"><option value="REJECTED">Reject</option><option value="CANCELLED">Cancel</option></Select>
                      <Input name="reason" placeholder="Reason (required)" className="h-8 w-56 text-xs" required />
                      <SubmitButton size="sm" variant="ghost" confirm="Void this execution? It stays in history but stops counting.">Void</SubmitButton>
                    </ActionForm>
                  </div>
                ))}
              </CardContent>
            ) : null}
          </Card>

          <Card>
            <CardHeader><CardTitle>Record execution</CardTitle><span className="text-xs text-muted">Partial executions are supported: record each fill separately.</span></CardHeader>
            <CardContent><RecordExecutionForm advice={a} action={recordExecutionAction.bind(null, itemId)} /></CardContent>
          </Card>

          {chain.length > 1 ? (
            <Card>
              <CardHeader><CardTitle>Revision history</CardTitle></CardHeader>
              <Table>
                <THead><TR><TH>Communicated</TH><TH className="text-right">Advised</TH><TH className="text-right">Executed</TH><TH>Status</TH><TH>Reason</TH></TR></THead>
                <TBody>
                  {chain.map((c) => (
                    <TR key={c.id} className={c.id === itemId ? "bg-blue-50/50" : undefined}>
                      <TD className="text-xs"><Link href={`/advice/items/${c.id}`} className="hover:underline">{formatDateTime(c.communicated_at)}</Link> <span className="text-muted">{c.batch_code}</span></TD>
                      <TD className="text-right"><Money value={c.advised_amount} full /></TD>
                      <TD className="text-right"><Money value={c.executed_amount} full /></TD>
                      <TD><StatusBadge status={c.status} /></TD>
                      <TD className="text-xs text-muted">{c.status === "REVISED" || c.status === "CANCELLED" ? c.status_reason : ""}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </Card>
          ) : null}
        </div>

        <div className="space-y-4">
          {canAdvise && a.is_open ? (
            <>
              <Card>
                <CardHeader><CardTitle>Revise call</CardTitle></CardHeader>
                <CardContent>
                  <p className="mb-3 text-xs text-muted">The original stays in history as REVISED. Enter the NEW TOTAL for this call; already executed {formatINR(a.executed_amount)} stays with the original.</p>
                  <ActionForm action={reviseAdviceAction.bind(null, itemId)} className="space-y-2">
                    <Field label="New total amount ₹ *"><Input name="new_total_amount" inputMode="decimal" required /></Field>
                    {a.quantity_basis === "UNITS" ? <Field label="New total units *"><Input name="new_total_units" inputMode="decimal" required /></Field> : null}
                    <Field label="Reason *"><Input name="reason" required placeholder="e.g. Market condition changed" /></Field>
                    <div className="grid grid-cols-2 gap-2">
                      <Field label="Communicated at"><Input type="datetime-local" name="communicated_at" defaultValue={toISTDateTimeLocal()} required /></Field>
                      <Field label="Channel"><Select name="channel" defaultValue={a.communication_channel}>{CHANNELS.map((c) => <option key={c}>{c}</option>)}</Select></Field>
                    </div>
                    <SubmitButton size="sm">Record revision</SubmitButton>
                  </ActionForm>
                </CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle>Cancel / expire remaining</CardTitle></CardHeader>
                <CardContent>
                  <ActionForm action={closeAdviceAction.bind(null, itemId)} className="space-y-2">
                    <Select name="status"><option value="CANCELLED">Cancel (advisor withdrew the call)</option><option value="EXPIRED">Expire (validity lapsed)</option></Select>
                    <Input name="reason" required placeholder="Reason (required)" />
                    <SubmitButton size="sm" variant="danger" confirm="Close the remaining part of this call?">Close call</SubmitButton>
                  </ActionForm>
                </CardContent>
              </Card>
            </>
          ) : null}
          <Card>
            <CardHeader><CardTitle>Follow-up notes</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {notes.map((n) => (
                <div key={n.id} className="text-sm">
                  <div className="text-[11px] text-muted">{formatDateTime(n.created_at)} · {n.author}{n.follow_up_date ? ` · follow up ${formatDate(n.follow_up_date)}` : ""}</div>
                  <div className="whitespace-pre-wrap">{n.body}</div>
                </div>
              ))}
              <ActionForm action={followUpNoteAction.bind(null, a.client_id, itemId)} className="space-y-2" resetOnSuccess>
                <Textarea name="body" rows={2} placeholder="e.g. Client will redeem tomorrow" required />
                <Input type="date" name="follow_up_date" />
                <SubmitButton size="sm" variant="outline">Add follow-up</SubmitButton>
              </ActionForm>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
