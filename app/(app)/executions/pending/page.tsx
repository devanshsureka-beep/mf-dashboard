import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Button, LinkButton } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import { Money } from "@/components/app/money";
import { ActionBadge } from "@/components/app/status-badge";
import { EmptyState, PageHeader } from "@/components/app/page-header";
import { RecordExecutionForm } from "@/components/app/record-execution-form";
import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { formatDate, formatUnits } from "@/lib/format";
import { PAGES } from "@/lib/brand";
import { HubTabs } from "@/components/app/hub-tabs";
import { pageData } from "@/lib/server";
import { listAdvisors, listClientSummaries } from "@/services/clients";
import type { AdviceItemView } from "@/types/domain";
import { recordExecutionAction } from "../actions";
import { closeAdviceAction, followUpNoteAction } from "../../advice/actions";

export const metadata = { title: "Awaiting execution" };

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

  // One block per client, oldest call first.
  const groups: { client_id: string; client_name: string; client_code: string; advisor: string | null; rows: PendingRow[]; total: number }[] = [];
  for (const r of rows) {
    let g = groups.find((x) => x.client_id === r.client_id);
    if (!g) groups.push((g = { client_id: r.client_id, client_name: r.client_name, client_code: r.client_code, advisor: r.advisor_name, rows: [], total: 0 }));
    g.rows.push(r);
    g.total += r.pending_amount;
  }
  groups.sort((a, b) => Math.max(...b.rows.map((r) => r.age_days)) - Math.max(...a.rows.map((r) => r.age_days)));
  const qs = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...f, ...patch })) if (v) p.set(k, v);
    const q = p.toString();
    return `/executions/pending${q ? `?${q}` : ""}`;
  };
  const chip = (label: string, patch: Record<string, string | null>, on: boolean) => (
    <Link key={label} href={qs(patch)} className={`rounded-full px-3 py-1 text-xs ring-1 ${on ? "bg-ink text-white ring-ink" : "bg-white ring-border hover:bg-slate-50"}`}>{label}</Link>
  );
  const noFilter = !f.stale && !f.status && !f.side;

  return (
    <>
      <PageHeader
        title={PAGES.calls}
        subtitle={<>{rows.length} open call(s) · <Money value={total} className="font-medium text-amber-700" /> awaiting execution. Advice is not execution: record what the client actually did.</>}
        actions={canAdvise ? <LinkButton href="/advice/new">Issue call</LinkButton> : null}
      />
      <HubTabs hub="calls" active="pending" role={actor.role} counts={{ pending: rows.length }} />

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {chip("All", { stale: null, status: null, side: null }, noFilter)}
        {chip("Older than 3 days", { stale: f.stale ? null : "1" }, Boolean(f.stale))}
        {chip("Partly executed", { status: f.status === "PARTIAL" ? null : "PARTIAL" }, f.status === "PARTIAL")}
        {chip("Not started", { status: f.status === "PENDING" ? null : "PENDING" }, f.status === "PENDING")}
        {chip("Sell", { side: f.side === "SELL" ? null : "SELL" }, f.side === "SELL")}
        {chip("Buy", { side: f.side === "BUY" ? null : "BUY" }, f.side === "BUY")}
        <form method="get" className="ml-auto flex gap-1.5">
          {f.stale ? <input type="hidden" name="stale" value="1" /> : null}
          {f.status ? <input type="hidden" name="status" value={f.status} /> : null}
          {f.side ? <input type="hidden" name="side" value={f.side} /> : null}
          <Select name="client" defaultValue={f.client ?? ""} className="h-8 w-52 text-xs" aria-label="Client">
            <option value="">All clients</option>
            {clients.map((c) => <option key={c.client_id} value={c.client_id}>{c.full_name}</option>)}
          </Select>
          {actor.role !== "ADVISOR" ? (
            <Select name="advisor" defaultValue={f.advisor ?? ""} className="h-8 w-40 text-xs" aria-label="Advisor">
              <option value="">All advisors</option>
              {advisors.map((a) => <option key={a.id} value={a.id}>{a.full_name}</option>)}
            </Select>
          ) : null}
          <Button type="submit" variant="outline" size="sm">Apply</Button>
        </form>
      </div>

      {groups.length === 0 ? <EmptyState title="Nothing awaiting execution">Every issued call has been fully executed, cancelled or expired.</EmptyState> : (
        <div className="space-y-3">
          {groups.map((g) => (
            <Card key={g.client_id} className="overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-slate-50 px-4 py-2">
                <div><Link className="font-semibold hover:underline" href={`/clients/${g.client_id}`}>{g.client_name}</Link> <span className="text-xs text-muted">{g.client_code}{g.advisor ? ` · ${g.advisor}` : ""}</span></div>
                <span className="text-xs font-semibold text-amber-700"><Money value={g.total} /> pending</span>
              </div>
              {g.rows.map((r) => (
                <details key={r.advice_item_id} className="group border-t border-border first:border-t-0">
                  <summary className="grid cursor-pointer list-none grid-cols-[92px_minmax(0,2.2fr)_1fr_1fr_1fr_96px] items-center gap-2 px-4 py-2 text-[13px] hover:bg-slate-50/70 [&::-webkit-details-marker]:hidden">
                    <span className="text-xs text-muted">{formatDate(r.communicated_at)}<span className={`block text-[11px] ${r.age_days > 3 ? "font-semibold text-red-700" : ""}`}>{r.age_days} day(s)</span></span>
                    <span className="min-w-0"><ActionBadge action={r.action} /> <span className="font-medium">{r.scheme_name}</span><span className="block text-[11px] text-muted">{r.batch_code}{r.quantity_basis === "UNITS" ? ` · ${formatUnits(r.advised_units)} units` : ""}</span></span>
                    <span className="text-right">Advised <b><Money value={r.advised_amount} /></b></span>
                    <span className="text-right text-emerald-700">Done <Money value={r.executed_amount} /></span>
                    <span className="text-right font-semibold text-amber-700">Pending <Money value={r.pending_amount} /></span>
                    <span className="justify-self-end rounded-md bg-brand px-3 py-1 text-xs font-semibold text-white group-open:bg-slate-200 group-open:text-ink">
                      <span className="group-open:hidden">Record</span><span className="hidden group-open:inline">Close</span>
                    </span>
                  </summary>
                  <div className="space-y-3 bg-slate-50/80 px-4 pb-4 pl-[116px] pt-2">
                    <RecordExecutionForm compact advice={{ quantity_basis: r.quantity_basis, pending_amount: r.pending_amount, pending_units: r.pending_units, action: r.action }} action={recordExecutionAction.bind(null, r.advice_item_id)} />
                    <div className="flex flex-wrap gap-4 text-xs">
                      <Link className="text-brand hover:underline" href={`/advice/items/${r.advice_item_id}`}>Open the call (proof upload, time, corrections)</Link>
                      <details>
                        <summary className="cursor-pointer text-muted">Follow-up note{canAdvise ? " / cancel" : ""}</summary>
                        <div className="mt-2 w-96 space-y-3 rounded-lg border border-border bg-white p-3">
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
                    </div>
                  </div>
                </details>
              ))}
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
