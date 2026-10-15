import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { recheckAllSipsAction } from "../clients/[id]/actions";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Money } from "@/components/app/money";
import { StatusBadge } from "@/components/app/status-badge";
import { EmptyState, PageHeader } from "@/components/app/page-header";
import { PAGES } from "@/lib/brand";
import { casPasswordTemplate } from "@/lib/cas/password";
import { formatDate, formatDateTime, formatINRCompact, humanize } from "@/lib/format";
import { pageData } from "@/lib/server";
import { cn } from "@/lib/utils";
import { askCasHref } from "@/lib/ask-cas";
import { getCasInbox } from "@/services/cas-inbox";
import { listCasDocuments } from "@/services/portfolio";
import { listRuns } from "@/services/reconciliation";
import { BulkUploader } from "../cas/bulk/bulk-uploader";

// Reading PDFs and saving a whole CAS can take a while on a cold start.
export const maxDuration = 300; // the bulk uploader here may send a picture-only CAS to Claude (up to 4 min)

export const metadata = { title: PAGES.casInbox };

function Column({ n, title, count, tone, children, empty }: { n: number; title: string; count: number; tone: string; children: React.ReactNode; empty: string }) {
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-2">
      <div className="flex items-baseline justify-between px-1">
        <h2 className="text-[13px] font-semibold">{n} · {title}</h2>
        <span className={cn("text-sm font-semibold", count ? tone : "text-muted")}>{count}</span>
      </div>
      {count ? children : <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted">{empty}</p>}
    </section>
  );
}

function Item({ accent, children }: { accent?: string; children: React.ReactNode }) {
  return <article className={cn("rounded-lg border border-border bg-white px-3 py-2.5 text-[13px]", accent && `border-l-[3px] ${accent}`)}>{children}</article>;
}

export default async function CasInboxPage() {
  const { inbox, runs, docs, actor } = await pageData(async (tx) => ({
    inbox: await getCasInbox(tx),
    runs: await listRuns(tx),
    docs: await listCasDocuments(tx),
  }));
  const templateSet = casPasswordTemplate() !== null;

  return (
    <>
      <PageHeader
        title={PAGES.casInbox}
        subtitle="Drop new CAS files (or a whole folder). Each is read, matched to its client and checked against the calls; advised trades it shows are marked done by itself. You only see what needs you."
      />
      {!templateSet ? (
        <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          The CAS password template (<code>CAS_PASSWORD_TEMPLATE</code>) is not configured, so password-protected files can only be opened with a password typed in the uploader.
        </p>
      ) : null}

      <BulkUploader />

      {actor.role === "ADMIN" ? (
        <ActionForm action={recheckAllSipsAction} className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-white px-4 py-2.5 text-sm">
          <span className="text-muted">SIP lines of every active plan: tick those the CAS already shows started, changed or stopped since the report.</span>
          <SubmitButton size="sm" variant="outline">Re-check all SIPs from CAS</SubmitButton>
        </ActionForm>
      ) : null}

      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Column n={1} title="Reading" count={inbox.reading.length} tone="text-indigo-700" empty="Nothing being read.">
          {inbox.reading.map((r) => (
            <Item key={r.cas_id} accent={r.status === "FAILED" ? "border-l-red-500" : undefined}>
              <Link href={`/clients/${r.client_id}`} className="font-semibold hover:underline">{r.client_name}</Link>
              <div className="text-xs text-muted">Uploaded {formatDateTime(r.uploaded_at)}</div>
              {r.status === "FAILED"
                ? <div className="mt-1 text-xs text-red-700">{r.error ?? "Could not be read"} · <Link className="text-brand hover:underline" href={`/cas/${r.cas_id}`}>Open</Link></div>
                : <div className="mt-1 text-xs text-indigo-700">{humanize(r.status)}…</div>}
            </Item>
          ))}
        </Column>

        <Column n={2} title="Check what we read" count={inbox.check.length + inbox.confirm.length} tone="text-amber-700" empty="No CAS waiting for a check.">
          {inbox.confirm.map((c) => (
            <Item key={c.run_id} accent="border-l-amber-500">
              <Link href={`/clients/${c.client_id}`} className="font-semibold hover:underline">{c.client_name}</Link> <span className="text-xs text-muted">{c.client_code}</span>
              <div className="text-xs text-muted">CAS of {formatDate(c.snapshot_date)}</div>
              <div className="mt-1 text-xs text-amber-800">{c.matches} advised trade(s) to confirm{c.first ? ` · ${c.first}` : ""}</div>
              <Link href={`/reconciliation/${c.run_id}`} className="mt-1 inline-block text-xs font-medium text-brand hover:underline">Confirm done / part done →</Link>
            </Item>
          ))}
          {inbox.check.map((c) => (
            <Item key={c.snapshot_id} accent="border-l-amber-500">
              <Link href={`/clients/${c.client_id}`} className="font-semibold hover:underline">{c.client_name}</Link> <span className="text-xs text-muted">{c.client_code}</span>
              <div className="text-xs text-muted">CAS of {formatDate(c.snapshot_date)} · {c.funds} fund(s) · {formatINRCompact(c.value)}</div>
              {c.warnings ? <div className="mt-1 text-xs text-amber-800">{c.warnings} point(s) to check</div> : null}
              <Link href={c.cas_id ? `/cas/${c.cas_id}` : `/snapshots/${c.snapshot_id}`} className="mt-1 inline-block text-xs font-medium text-brand hover:underline">Check &amp; confirm →</Link>
            </Item>
          ))}
        </Column>

        <Column n={3} title="Unadvised Trades" count={inbox.unadvised.length} tone="text-red-700" empty="Nothing to review.">
          {inbox.unadvised.map((u) => (
            <Item key={u.run_id} accent="border-l-red-500">
              <Link href={`/clients/${u.client_id}`} className="font-semibold hover:underline">{u.client_name}</Link> <span className="text-xs text-muted">{u.client_code}</span>
              <div className="text-xs text-muted">CAS of {formatDate(u.snapshot_date)}</div>
              <div className="mt-1 text-xs">{u.trades} trade(s) {formatINRCompact(u.amount)}{u.matched ? <span className="text-emerald-700"> · {u.matched} call(s) matched ✓</span> : null}</div>
              <Link href={`/reconciliation/${u.run_id}`} className="mt-1 inline-block text-xs font-medium text-brand hover:underline">Review: advised / not advised →</Link>
            </Item>
          ))}
        </Column>

        <Column n={4} title="Done (last 30 days)" count={inbox.done.length} tone="text-emerald-700" empty="Nothing finished yet.">
          {inbox.done.slice(0, 6).map((d) => (
            <Item key={`${d.client_id}-${d.snapshot_date}`}>
              <Link href={`/clients/${d.client_id}`} className="font-semibold hover:underline">{d.client_name}</Link>
              <div className="text-xs text-muted">CAS of {formatDate(d.snapshot_date)}</div>
              <div className="mt-1 text-xs text-emerald-700">
                {d.run_id && d.verified ? `${d.verified} advised trade(s) marked done ✓${d.unadvised_reviewed ? ` · ${d.unadvised_reviewed} unadvised reviewed` : ""}` : "Portfolio updated ✓"}
              </div>
            </Item>
          ))}
          {inbox.done.length > 6 ? <p className="px-1 text-xs text-muted">+ {inbox.done.length - 6} more</p> : null}
        </Column>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <div>
            <CardTitle>CAS to collect · {inbox.collect.length}</CardTitle>
            <p className="mt-0.5 text-xs text-muted">Clients with advice no CAS has shown yet, or no CAS for more than 30 days. Their &ldquo;Waiting&rdquo; only clears when a new CAS comes in.</p>
          </div>
        </CardHeader>
        {inbox.collect.length === 0 ? <CardContent><EmptyState title="Every client's CAS is up to date" /></CardContent> : (
          <Table className="text-[13px]">
            <THead><TR><TH>Client</TH><TH>Latest CAS</TH><TH>Why</TH><TH /></TR></THead>
            <TBody>
              {inbox.collect.map((c) => (
                <TR key={c.client_id}>
                  <TD><Link href={`/clients/${c.client_id}`} className="font-medium hover:underline">{c.client_name}</Link> <span className="text-xs text-muted">{c.client_code}</span></TD>
                  <TD className="text-xs">{c.latest_cas ? `${formatDate(c.latest_cas)} (${c.days} days ago)` : "None yet"}</TD>
                  <TD className="text-xs">{c.waiting_amount >= 0.5 ? <><Money value={c.waiting_amount} /> advised, not seen in a CAS yet</> : c.unverified_amount >= 0.5 ? <><Money value={c.unverified_amount} /> recorded by hand, not yet seen in a CAS</> : c.latest_cas ? `${c.days} days without a CAS` : "No CAS uploaded"}</TD>
                  <TD className="whitespace-nowrap text-right text-xs">
                    <a className="font-medium text-brand hover:underline" href={askCasHref({ client_id: c.client_id, full_name: c.client_name, phone: c.phone })} target="_blank" rel="noreferrer">Ask client</a>
                    {" · "}<Link className="font-medium text-brand hover:underline" href={`/clients/${c.client_id}/cas/upload`}>Upload</Link>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <details className="mt-4 rounded-xl border border-border bg-surface">
        <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-semibold">Every matching run and every CAS file</summary>
        <div className="space-y-4 border-t border-border p-3">
          <Card>
            <CardHeader><CardTitle>Matching runs</CardTitle></CardHeader>
            {runs.length === 0 ? <CardContent><EmptyState title="No runs yet" /></CardContent> : (
              <Table>
                <THead><TR><TH>Client</TH><TH>Compared</TH><TH className="text-right">Previous value</TH><TH className="text-right">New value</TH><TH>Summary</TH><TH>Open items</TH><TH>Status</TH><TH /></TR></THead>
                <TBody>
                  {runs.map((r) => (
                    <TR key={r.id}>
                      <TD className="whitespace-nowrap"><Link href={`/clients/${r.client_id}`} className="hover:underline">{r.client_name}</Link><div className="text-[11px] text-muted">{formatDateTime(r.created_at)}</div></TD>
                      <TD className="text-xs">{formatDate(r.previous_snapshot_date)} → {formatDate(r.current_snapshot_date)}</TD>
                      <TD className="text-right"><Money value={r.previous_value} /></TD>
                      <TD className="text-right"><Money value={r.current_value} /></TD>
                      <TD className="text-xs text-muted">{r.summary.transactions != null ? `${r.summary.transactions} transactions · ${r.summary.auto_confirmed ?? 0} auto-confirmed` : `${r.summary.changes ?? 0} changes`} · {r.summary.advice_matches ?? 0} advice matches · {r.summary.unadvised ?? 0} unadvised · {r.summary.sip_instalments ?? 0} SIP</TD>
                      <TD className={`num ${r.open_matches ? "font-semibold text-amber-700" : "text-muted"}`}>{r.open_matches}</TD>
                      <TD><StatusBadge status={r.status} /></TD>
                      <TD><Link className="text-xs text-brand hover:underline" href={`/reconciliation/${r.id}`}>Review →</Link></TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>
          <Card>
            <CardHeader><CardTitle>CAS files</CardTitle></CardHeader>
            {docs.length === 0 ? <CardContent><EmptyState title="No CAS uploaded yet" /></CardContent> : (
              <Table>
                <THead><TR><TH>Uploaded</TH><TH>Client</TH><TH>File</TH><TH>Source</TH><TH>Valuation</TH><TH>Parse status</TH><TH>Snapshot</TH></TR></THead>
                <TBody>
                  {docs.map((d) => (
                    <TR key={d.id}>
                      <TD className="whitespace-nowrap text-xs">{formatDateTime(d.uploaded_at)}</TD>
                      <TD className="whitespace-nowrap">{d.client_name}</TD>
                      <TD className="max-w-60 truncate text-xs"><Link className="text-brand hover:underline" href={`/cas/${d.id}`}>{d.file_name}</Link></TD>
                      <TD className="text-xs">{humanize(d.source)}</TD>
                      <TD className="text-xs">{formatDate(d.valuation_date)}</TD>
                      <TD><StatusBadge status={d.parse_status} /></TD>
                      <TD>{d.snapshot_id ? <Link href={`/snapshots/${d.snapshot_id}`}><StatusBadge status={d.snapshot_review_status} /></Link> : <span className="text-xs text-muted">—</span>}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>
        </div>
      </details>
    </>
  );
}
