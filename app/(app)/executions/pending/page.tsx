import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Button, LinkButton } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import { Money } from "@/components/app/money";
import { ActionBadge } from "@/components/app/status-badge";
import { EmptyState, PageHeader } from "@/components/app/page-header";
import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { formatDate, formatDayMonth, formatUnits } from "@/lib/format";
import { askCasHref } from "@/lib/ask-cas";
import { cn } from "@/lib/utils";
import { PAGES } from "@/lib/brand";
import { HubTabs } from "@/components/app/hub-tabs";
import { pageData } from "@/lib/server";
import { listAdvisors, listClientSummaries } from "@/services/clients";
import { listWaiting, type WaitingCall } from "@/services/waiting";
import { closeAdviceAction, followUpNoteAction } from "../../advice/actions";

export const metadata = { title: "Waiting for clients" };

type PendingRow = WaitingCall;

export default async function PendingExecutionsPage(props: PageProps<"/executions/pending">) {
  const sp = await props.searchParams;
  const one = (k: string) => (typeof sp[k] === "string" && sp[k] ? (sp[k] as string) : null);
  const f = { client: one("client"), advisor: one("advisor"), status: one("status"), side: one("side"), stale: one("stale") };
  const statusFilter = f.status === "PENDING" ? "ISSUED" : f.status === "PARTIAL" ? "PARTIALLY_EXECUTED" : null;
  const { rows, clients, advisors, actor } = await pageData(async (tx) => ({
    rows: await listWaiting(tx, { clientId: f.client, advisorId: f.advisor, status: statusFilter, side: f.side === "BUY" || f.side === "SELL" ? f.side : null, stale: Boolean(f.stale) }),
    clients: await listClientSummaries(tx),
    advisors: await listAdvisors(tx),
  }));
  const canAdvise = actor.role !== "OPERATIONS";
  const total = rows.reduce((s, r) => s + r.pending_amount, 0);

  // One block per client, oldest call first.
  const groups: { client_id: string; client_name: string; client_code: string; phone: string | null; advisor: string | null; rows: PendingRow[]; total: number }[] = [];
  for (const r of rows) {
    let g = groups.find((x) => x.client_id === r.client_id);
    if (!g) groups.push((g = { client_id: r.client_id, client_name: r.client_name, client_code: r.client_code, phone: r.phone, advisor: r.advisor_name, rows: [], total: 0 }));
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
        subtitle={<>{rows.length} open call(s) · <Money value={total} className="font-medium text-amber-700" /> waiting for clients. Nothing to record: Done fills in from each new CAS.</>}
        actions={canAdvise ? <LinkButton href="/advice/new">Issue call</LinkButton> : null}
      />
      <HubTabs hub="calls" active="pending" role={actor.role} counts={{ pending: rows.length }} />

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {chip("All", { stale: null, status: null, side: null }, noFilter)}
        {chip("Older than 3 days", { stale: f.stale ? null : "1" }, Boolean(f.stale))}
        {chip("Part done", { status: f.status === "PARTIAL" ? null : "PARTIAL" }, f.status === "PARTIAL")}
        {chip("Not in CAS yet", { status: f.status === "PENDING" ? null : "PENDING" }, f.status === "PENDING")}
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

      {groups.length === 0 ? <EmptyState title="Nothing waiting">Every issued call has shown up in a CAS, or was cancelled or expired.</EmptyState> : (
        <div className="space-y-3">
          {groups.map((g) => (
            <Card key={g.client_id} className="overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-slate-50 px-4 py-2">
                <div><Link className="font-semibold hover:underline" href={`/clients/${g.client_id}`}>{g.client_name}</Link> <span className="text-xs text-muted">{g.client_code}{g.advisor ? ` · ${g.advisor}` : ""}</span></div>
                <span className="flex items-center gap-3 text-xs"><a href={askCasHref({ client_id: g.client_id, full_name: g.client_name, phone: g.phone })} target="_blank" rel="noreferrer" className="font-medium text-brand hover:underline">Ask for CAS</a><Link href={`/clients/${g.client_id}/cas/upload`} className="font-medium text-brand hover:underline">Upload CAS</Link><b className="text-amber-700"><Money value={g.total} /> waiting</b></span>
              </div>
              {g.rows.map((r) => {
                const st = r.to_confirm ? { label: "Check in CAS inbox", cls: "bg-red-50 text-red-800", href: "/reconciliation" }
                  : r.executed_amount >= 0.5 ? { label: "Part done", cls: "bg-amber-50 text-amber-900", href: null }
                  : { label: r.cas_after ? `Not in CAS ${formatDayMonth(r.cas_after)}` : "Not in CAS yet", cls: "bg-orange-50 text-orange-800", href: null };
                return (
                  <details key={r.advice_item_id} className="group border-t border-border first:border-t-0">
                    <summary className="grid cursor-pointer list-none grid-cols-[92px_minmax(0,2.2fr)_1fr_1fr_1fr_150px] items-center gap-2 px-4 py-2 text-[13px] hover:bg-slate-50/70 [&::-webkit-details-marker]:hidden">
                      <span className="text-xs text-muted">{formatDate(r.communicated_at)}<span className={`block text-[11px] ${r.age_days > 3 ? "font-semibold text-red-700" : ""}`}>{r.age_days} day(s)</span></span>
                      <span className="min-w-0"><ActionBadge action={r.action} /> <span className="font-medium">{r.scheme_name}</span><span className="block text-[11px] text-muted">{r.batch_code}{r.quantity_basis === "UNITS" ? ` · ${formatUnits(r.advised_units)} units` : ""}</span></span>
                      <span className="text-right">Advised <b><Money value={r.advised_amount} /></b></span>
                      <span className="text-right text-emerald-700">Done <Money value={r.executed_amount} />{r.done_on ? <span className="block text-[11px] text-muted">{formatDate(r.done_on)}</span> : null}</span>
                      <span className="text-right font-semibold text-amber-700"><Money value={r.pending_amount} /> waiting</span>
                      <span className="justify-self-end">
                        {st.href ? <Link href={st.href} className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold hover:underline", st.cls)}>{st.label}</Link>
                          : <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", st.cls)}>{st.label}</span>}
                        <span className="ml-1.5 text-xs text-muted group-open:hidden" aria-hidden>⋯</span>
                      </span>
                    </summary>
                    <div className="flex flex-wrap gap-4 bg-slate-50/80 px-4 pb-4 pl-[116px] pt-2 text-xs">
                      <Link className="text-brand hover:underline" href={`/advice/items/${r.advice_item_id}`}>Open the call</Link>
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
                  </details>
                );
              })}
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
