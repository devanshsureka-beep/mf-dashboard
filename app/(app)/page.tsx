import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { LinkButton } from "@/components/ui/button";
import { StatCard } from "@/components/app/stat-card";
import { Money } from "@/components/app/money";
import { ActionBadge, StatusBadge } from "@/components/app/status-badge";
import { PageHeader, EmptyState } from "@/components/app/page-header";
import { formatDate, formatDateTime, formatINRCompact, humanize } from "@/lib/format";
import { pageData } from "@/lib/server";
import { getCommandCentreMetrics, listDocumentsNeedingReview, listReviewDue } from "@/services/dashboard";
import { listAdviceLedger } from "@/services/advice";
import { listUnadvisedActivity } from "@/services/reconciliation";
import { listDueFollowUps } from "@/services/notes";

export const metadata = { title: "Command Centre" };

export default async function CommandCentre() {
  const { m, recent, unadvised, docs, reviews, followUps, actor } = await pageData(async (tx) => ({
    m: await getCommandCentreMetrics(tx),
    recent: await listAdviceLedger(tx, { limit: 12 }),
    unadvised: await listUnadvisedActivity(tx, 8),
    docs: await listDocumentsNeedingReview(tx, 8),
    reviews: await listReviewDue(tx, 8),
    followUps: await listDueFollowUps(tx, 8),
  }));

  return (
    <>
      <PageHeader
        title="Command Centre"
        subtitle={<>Good day, {actor.fullName.split(" ")[0] || "there"} · {formatDate(m.day)} (IST)</>}
        actions={
          actor.role !== "OPERATIONS" ? (
            <>
              <LinkButton href="/advice/new?side=SELL" variant="outline">Issue sell call</LinkButton>
              <LinkButton href="/advice/new?side=BUY">Issue buy call</LinkButton>
            </>
          ) : (
            <LinkButton href="/executions/pending">Record executions</LinkButton>
          )
        }
      />

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Total clients" value={m.total_clients} href="/clients" />
        <StatCard label="Total portfolio value" value={formatINRCompact(m.total_portfolio_value)} hint="Latest confirmed CAS per client" />
        <StatCard label="Active advisory plans" value={m.active_plans} hint={m.draft_plans ? `${m.draft_plans} draft awaiting approval` : undefined} />
        <StatCard label="Calls issued today" value={m.calls_issued_today} hint={`${m.advice_items_today} individual calls`} href={`/advice?from=${m.day}&to=${m.day}`} />
      </section>

      <h2 className="mb-2 mt-6 text-xs font-semibold uppercase tracking-wide text-muted">Today</h2>
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Sell advised" value={formatINRCompact(m.sell_advised_today)} href={`/advice?from=${m.day}&to=${m.day}&side=SELL`} />
        <StatCard label="Buy advised" value={formatINRCompact(m.buy_advised_today)} href={`/advice?from=${m.day}&to=${m.day}&side=BUY`} />
        <StatCard label="Executed value" value={formatINRCompact(m.executed_value_today)} tone="success" />
        <StatCard label="Pending value (all open calls)" value={formatINRCompact(m.pending_value_total)} tone={m.pending_value_total > 0 ? "attention" : "default"} href="/executions/pending" />
      </section>

      <h2 className="mb-2 mt-6 text-xs font-semibold uppercase tracking-wide text-muted">Needs attention</h2>
      <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Pending executions" value={m.pending_executions} hint={`${m.stale_pending_executions} older than 3 days`} tone={m.stale_pending_executions ? "attention" : "default"} href="/executions/pending?status=PENDING" />
        <StatCard label="Partial executions" value={m.partial_executions} tone={m.partial_executions ? "attention" : "default"} href="/executions/pending?status=PARTIAL" />
        <StatCard label="CAS matches to review" value={m.cas_mismatches} tone={m.cas_mismatches ? "attention" : "default"} href="/reconciliation" />
        <StatCard label="Unadvised activity" value={m.unadvised_activity} tone={m.unadvised_activity ? "danger" : "default"} href="#unadvised" />
        <StatCard label="Documents to review" value={m.cas_needs_review + m.draft_plans} tone={m.cas_needs_review + m.draft_plans ? "attention" : "default"} href="#documents" />
        <StatCard label="Reviews & follow-ups due" value={m.review_due + m.follow_ups_due} tone={m.review_due + m.follow_ups_due ? "attention" : "default"} href="#reviews" />
      </section>

      <div className="mt-6 grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Recent advice</CardTitle>
            <Link href="/advice" className="text-xs text-brand hover:underline">Open ledger →</Link>
          </CardHeader>
          {recent.length === 0 ? (
            <CardContent><EmptyState title="No calls issued yet" /></CardContent>
          ) : (
            <Table>
              <THead>
                <TR><TH>Time</TH><TH>Client</TH><TH>Action</TH><TH>Security</TH><TH className="text-right">Advised</TH><TH className="text-right">Pending</TH><TH>Status</TH></TR>
              </THead>
              <TBody>
                {recent.map((a) => (
                  <TR key={a.id}>
                    <TD className="whitespace-nowrap text-xs text-muted">{formatDateTime(a.communicated_at)}</TD>
                    <TD className="whitespace-nowrap"><Link className="hover:underline" href={`/clients/${a.client_id}`}>{a.client_name}</Link></TD>
                    <TD><ActionBadge action={a.action} /></TD>
                    <TD className="max-w-56 truncate" title={a.scheme_name}><Link className="hover:underline" href={`/advice/items/${a.id}`}>{a.scheme_name}</Link></TD>
                    <TD className="text-right"><Money value={a.advised_amount} /></TD>
                    <TD className="text-right"><Money value={a.pending_amount} className={a.pending_amount > 0 ? "text-amber-700" : "text-muted"} /></TD>
                    <TD><StatusBadge status={a.status} /></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>

        <Card id="unadvised">
          <CardHeader><CardTitle>Unadvised activity</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {unadvised.length === 0 ? (
              <p className="text-sm text-muted">No unexplained portfolio changes.</p>
            ) : (
              unadvised.map((u) => (
                <Link key={u.id} href={`/reconciliation/${u.run_id}`} className="block rounded-md border border-red-100 bg-red-50/40 p-3 hover:border-red-200">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{u.client_name}</span>
                    <span className="text-xs text-red-700 num">{u.detected_change < 0 ? "−" : "+"}{formatINRCompact(u.approx_amount)}</span>
                  </div>
                  <div className="truncate text-xs text-muted" title={u.scheme_name}>{u.scheme_name}</div>
                  <div className="text-[11px] text-muted">UNADVISED {humanize(u.change_type)} · CAS {formatDate(u.snapshot_date)}</div>
                </Link>
              ))
            )}
          </CardContent>
        </Card>

        <Card id="documents">
          <CardHeader><CardTitle>Documents & drafts to review</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {docs.length === 0 ? <p className="text-sm text-muted">Nothing waiting.</p> : docs.map((d) => (
              <Link
                key={`${d.kind}-${d.id}`}
                href={d.kind === "PLAN" ? `/clients/${d.client_id}/plans/${d.id}` : d.kind === "SNAPSHOT" ? `/snapshots/${d.id}` : `/clients/${d.client_id}?tab=cas`}
                className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-gray-50"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{d.client_name}</span>
                  <span className="block truncate text-xs text-muted">{d.kind === "PLAN" ? "Draft plan" : d.kind === "SNAPSHOT" ? "Extracted snapshot" : "CAS"} · {d.label}</span>
                </span>
                <StatusBadge status={d.status} />
              </Link>
            ))}
          </CardContent>
        </Card>

        <Card id="reviews" className="xl:col-span-2">
          <CardHeader><CardTitle>Reviews & follow-ups due</CardTitle></CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div>
              <div className="mb-1 text-xs font-medium uppercase text-muted">Portfolio reviews (next 7 days)</div>
              {reviews.length === 0 ? <p className="text-sm text-muted">None.</p> : reviews.map((r) => (
                <Link key={r.client_id} href={`/clients/${r.client_id}`} className="flex justify-between rounded px-2 py-1 text-sm hover:bg-gray-50">
                  <span>{r.full_name} <span className="text-xs text-muted">· {r.advisor_name}</span></span>
                  <span className="text-xs num text-amber-700">{formatDate(r.next_review_date)}</span>
                </Link>
              ))}
            </div>
            <div>
              <div className="mb-1 text-xs font-medium uppercase text-muted">Follow-ups</div>
              {followUps.length === 0 ? <p className="text-sm text-muted">None.</p> : followUps.map((f) => (
                <Link key={f.id} href={`/clients/${f.client_id}?tab=notes`} className="block rounded px-2 py-1 text-sm hover:bg-gray-50">
                  <div className="flex justify-between"><span className="font-medium">{f.client_name}</span><span className="text-xs num text-amber-700">{formatDate(f.follow_up_date)}</span></div>
                  <div className="truncate text-xs text-muted">{f.body}</div>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
