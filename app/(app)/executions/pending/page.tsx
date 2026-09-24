import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import { Money } from "@/components/app/money";
import { ActionBadge } from "@/components/app/status-badge";
import { EmptyState, PageHeader } from "@/components/app/page-header";
import { RecordExecutionForm } from "@/components/app/record-execution-form";
import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { formatDate, formatDateTime, formatUnits } from "@/lib/format";
import { pageData } from "@/lib/server";
import { listAdvisors, listClientSummaries } from "@/services/clients";
import type { AdviceItemView } from "@/types/domain";
import { recordExecutionAction } from "../actions";
import { closeAdviceAction, followUpNoteAction } from "../../advice/actions";

export const metadata = { title: "Pending executions" };

interface PendingRow {
  advice_item_id: string; client_id: string; client_code: string; client_name: string; advisor_id: string; advisor_name: string | null;
  batch_code: string; security_id: string; scheme_name: string; action: AdviceItemView["action"]; quantity_basis: "AMOUNT" | "UNITS";
  advised_amount: number; advised_units: number | null; executed_amount: number; executed_units: number; pending_amount: number;
  pending_units: number | null; status: string; communicated_at: Date; communication_channel: string; age_days: number;
}

export default async function PendingExecutionsPage(props: PageProps<"/executions/pending">) {
  const sp = await props.searchParams;
  const one = (k: string) => (typeof sp[k] === "string" && sp[k] ? (sp[k] as string) : null);
  const f = { client: one("client"), advisor: one("advisor"), status: one("status"), side: one("side"), stale: one("stale") };
  const statusFilter = f.status === "PENDING" ? "ISSUED" : f.status === "PARTIAL" ? "PARTIALLY_EXECUTED" : null;
  const { rows, clients, advisors, actor } = await pageData(async (tx) => ({
    rows: await tx<PendingRow[]>`
      select * from public.v_pending_executions
      where (${f.client}::uuid is null or client_id = ${f.client})
        and (${f.advisor}::uuid is null or advisor_id = ${f.advisor})
        and (${statusFilter}::text is null or status = ${statusFilter})
        and (${f.side}::text is null or (${f.side} = 'BUY' and action = 'BUY') or (${f.side} = 'SELL' and action <> 'BUY'))
        and (${f.stale}::text is null or age_days > 3)
      order by age_days desc, communicated_at`,
    clients: await listClientSummaries(tx),
    advisors: await listAdvisors(tx),
  }));
  const canAdvise = actor.role !== "OPERATIONS";
  const total = rows.reduce((s, r) => s + r.pending_amount, 0);

  return (
    <>
      <PageHeader
        title="Pending executions"
        subtitle={<>{rows.length} open calls · <Money value={total} className="font-medium text-amber-700" /> awaiting execution. Advice is not execution: record what the client actually did.</>}
      />
      <form method="get" className="sticky top-0 z-20 mb-4 flex flex-wrap items-end gap-2 rounded-lg border border-border bg-white/95 p-3 backdrop-blur">
        <Select name="client" defaultValue={f.client ?? ""} className="w-56">
          <option value="">All clients</option>
          {clients.map((c) => <option key={c.client_id} value={c.client_id}>{c.full_name}</option>)}
        </Select>
        {actor.role !== "ADVISOR" ? (
          <Select name="advisor" defaultValue={f.advisor ?? ""} className="w-44">
            <option value="">All advisors</option>
            {advisors.map((a) => <option key={a.id} value={a.id}>{a.full_name}</option>)}
          </Select>
        ) : null}
        <Select name="status" defaultValue={f.status ?? ""} className="w-48"><option value="">Pending + partial</option><option value="PENDING">Not started</option><option value="PARTIAL">Partial</option></Select>
        <Select name="side" defaultValue={f.side ?? ""} className="w-36"><option value="">Buy & sell</option><option value="SELL">Sell</option><option value="BUY">Buy</option></Select>
        <label className="flex items-center gap-1.5 px-2 text-sm"><input type="checkbox" name="stale" value="1" defaultChecked={Boolean(f.stale)} /> Older than 3 days</label>
        <Button type="submit" variant="outline">Filter</Button>
        <Link href="/executions/pending" className="px-2 text-xs text-muted hover:underline">Reset</Link>
      </form>

      <Card>
        {rows.length === 0 ? <CardContent><EmptyState title="Nothing pending">Every issued call has been fully executed, cancelled or expired.</EmptyState></CardContent> : (
          <Table className="text-[13px] [&_td]:px-2 [&_th]:px-2">
            <THead>
              <TR><TH>Client</TH><TH>Security</TH><TH>Action</TH><TH className="text-right">Amount advised</TH><TH className="text-right">Executed</TH><TH className="text-right">Pending</TH><TH>Advice date</TH><TH className="text-right">Age</TH><TH>Advisor</TH><TH>Quick actions</TH></TR>
            </THead>
            <TBody>
              {rows.map((r) => (
                <TR key={r.advice_item_id} className={r.age_days > 3 ? "bg-amber-50/40" : undefined}>
                  <TD className="whitespace-nowrap"><Link className="font-medium hover:underline" href={`/clients/${r.client_id}`}>{r.client_name}</Link><div className="text-[11px] text-muted">{r.client_code}</div></TD>
                  <TD className="max-w-52"><Link href={`/advice/items/${r.advice_item_id}`} className="block truncate hover:underline" title={r.scheme_name}>{r.scheme_name}</Link><div className="text-[11px] text-muted">{r.batch_code}{r.quantity_basis === "UNITS" ? ` · ${formatUnits(r.advised_units)} units` : ""}</div></TD>
                  <TD><ActionBadge action={r.action} /></TD>
                  <TD className="text-right"><Money value={r.advised_amount} /></TD>
                  <TD className="text-right text-emerald-700"><Money value={r.executed_amount} /></TD>
                  <TD className="text-right font-medium text-amber-700"><Money value={r.pending_amount} />{r.pending_units ? <div className="text-[10px] text-muted">{formatUnits(r.pending_units)} u</div> : null}</TD>
                  <TD className="whitespace-nowrap text-xs">{formatDate(r.communicated_at)}<div className="text-[10px] text-muted">{formatDateTime(r.communicated_at).split(" ").slice(1).join(" ")}</div></TD>
                  <TD className={`text-right num ${r.age_days > 3 ? "font-semibold text-amber-700" : ""}`}>{r.age_days}d</TD>
                  <TD className="whitespace-nowrap text-xs">{r.advisor_name}</TD>
                  <TD className="min-w-32">
                    <details className="text-xs">
                      <summary className="cursor-pointer text-brand">Record execution</summary>
                      <div className="absolute right-6 z-30 mt-1 w-[760px] rounded-lg border border-border bg-white p-3 shadow-lg">
                        <RecordExecutionForm compact advice={{ quantity_basis: r.quantity_basis, pending_amount: r.pending_amount, pending_units: r.pending_units, action: r.action }} action={recordExecutionAction.bind(null, r.advice_item_id)} />
                        <p className="mt-2 text-[11px] text-muted">Need proof upload or time? <Link className="text-brand" href={`/advice/items/${r.advice_item_id}`}>Open full call</Link></p>
                      </div>
                    </details>
                    <div className="mt-1 flex gap-2">
                      <Link className="text-brand hover:underline" href={`/clients/${r.client_id}`}>Open client</Link>
                    </div>
                    <details className="mt-1 text-xs">
                      <summary className="cursor-pointer text-muted">Follow-up note{canAdvise ? " / cancel" : ""}</summary>
                      <div className="absolute right-6 z-30 mt-1 w-96 space-y-3 rounded-lg border border-border bg-white p-3 shadow-lg">
                        <ActionForm action={followUpNoteAction.bind(null, r.client_id, r.advice_item_id)} className="space-y-2" resetOnSuccess>
                          <Input name="body" placeholder="Follow-up note" required />
                          <Input type="date" name="follow_up_date" />
                          <SubmitButton size="sm" variant="outline">Add follow-up note</SubmitButton>
                        </ActionForm>
                        {canAdvise ? (
                          <ActionForm action={closeAdviceAction.bind(null, r.advice_item_id)} className="space-y-2 border-t border-border pt-2">
                            <input type="hidden" name="status" value="CANCELLED" />
                            <Input name="reason" placeholder="Reason to cancel (required)" required />
                            <SubmitButton size="sm" variant="danger" confirm="Cancel the remaining part of this call?">Cancel advice</SubmitButton>
                          </ActionForm>
                        ) : null}
                      </div>
                    </details>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </>
  );
}
