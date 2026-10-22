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
import { formatDate, formatDateTime, humanize } from "@/lib/format";
import { pageData } from "@/lib/server";
import { cn, UUID_RE } from "@/lib/utils";
import { askCasHref } from "@/lib/ask-cas";
import { getCasInbox, getInboxCheckDetail, getInboxRunDetails, type InboxCheckDetail, type InboxRunDetail } from "@/services/cas-inbox";
import type { ClientSummary } from "@/types/domain";
import { InboxCase, reasons, TONE, type ClientCard } from "./inbox-case";
import { listCasDocuments } from "@/services/portfolio";
import { listRuns } from "@/services/reconciliation";
import { getApprovedVsCas } from "@/services/waiting-approve";
import { BulkUploader } from "../cas/bulk/bulk-uploader";
import { casLabel } from "@/services/documents";

// Reading PDFs and saving a whole CAS can take a while on a cold start.
export const maxDuration = 300; // the bulk uploader here may send a picture-only CAS to Claude (up to 4 min)

export const metadata = { title: PAGES.casInbox };

type Inbox = Awaited<ReturnType<typeof getCasInbox>>;

function cardsFromInbox(inbox: Inbox): ClientCard[] {
  const by = new Map<string, ClientCard>();
  const card = (id: string, name: string, code = ""): ClientCard => {
    let c = by.get(id);
    if (!c) {
      c = { client_id: id, client_name: name, client_code: code, snapshot_date: null, reading: [], check: [], runIds: [], approvedMissing: 0 };
      by.set(id, c);
    }
    if (code && !c.client_code) c.client_code = code;
    return c;
  };
  const later = (a: string | null, b: string) => (!a || b > a ? b : a);
  for (const r of inbox.reading) card(r.client_id, r.client_name).reading.push(r);
  for (const x of inbox.check) {
    const c = card(x.client_id, x.client_name, x.client_code);
    c.check.push(x);
    c.snapshot_date = later(c.snapshot_date, x.snapshot_date);
  }
  for (const x of [...inbox.confirm, ...inbox.unadvised]) {
    const c = card(x.client_id, x.client_name, x.client_code);
    if (!c.runIds.includes(x.run_id)) c.runIds.push(x.run_id);
    c.snapshot_date = later(c.snapshot_date, x.snapshot_date);
  }
  for (const x of inbox.approvedMissing) {
    const c = card(x.client_id, x.client_name, x.client_code);
    c.approvedMissing = x.trades;
    if (x.run_id && !c.runIds.includes(x.run_id)) c.runIds.push(x.run_id);
    c.snapshot_date = later(c.snapshot_date, x.snapshot_date);
  }
  return [...by.values()].sort((a, b) => (b.snapshot_date ?? "").localeCompare(a.snapshot_date ?? ""));
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const callName = (d: { scheme_name: string; action: string | null }) => `${d.scheme_name.replace(/\s*-\s*(direct|regular).*$/i, "").slice(0, 34)} ${d.action === "SELL" ? "sell" : d.action === "BUY" ? "buy" : ""}`.trim();

/** What the CAS ticked by itself, as green chips. */
function DoneChips({ d }: { d: InboxRunDetail | undefined }) {
  if (!d) return null;
  return (
    <>
      {d.done.length ? <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-emerald-800">✓ {plural(d.done.length, "call")} done ({d.done.slice(0, 2).map(callName).join(", ")}{d.done.length > 2 ? "…" : ""})</span> : null}
      {d.sip_lines_ticked ? <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-emerald-800">✓ {plural(d.sip_lines_ticked, "SIP line")} ticked</span> : null}
    </>
  );
}

function Tabs({ view, counts }: { view: string; counts: Record<string, number> }) {
  const tabs = [
    { key: "needs", label: "Needs you", href: "/reconciliation" },
    { key: "done", label: "Done · 30 days", href: "/reconciliation?view=done" },
    { key: "collect", label: "CAS to collect", href: "/reconciliation?view=collect" },
  ];
  return (
    <nav aria-label="Inbox" className="mb-3 mt-5 flex gap-0.5 border-b border-border">
      {tabs.map((t) => (
        <Link key={t.key} href={t.href} aria-current={view === t.key ? "page" : undefined}
          className={cn("-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-[13.5px]", view === t.key ? "border-brand font-semibold text-brand" : "border-transparent text-slate-600 hover:text-ink")}>
          {t.label} <span className={cn("ml-0.5 text-xs", t.key === "needs" && counts.needs ? "font-semibold text-amber-700" : "text-muted")}>{counts[t.key]}</span>
        </Link>
      ))}
    </nav>
  );
}

export default async function CasInboxPage(props: PageProps<"/reconciliation">) {
  const sp = await props.searchParams;
  const view = sp.view === "done" || sp.view === "collect" ? sp.view : "needs";
  const want = typeof sp.c === "string" && UUID_RE.test(sp.c) ? sp.c : null;
  const { inbox, runs, docs, details, cards, selected, checks, summary, inBank, approved, wantedName, actor } = await pageData(async (tx) => {
    const inbox = await getCasInbox(tx);
    const runIds = [...new Set([...inbox.confirm, ...inbox.unadvised].map((x) => x.run_id).concat(inbox.done.flatMap((d) => (d.run_id ? [d.run_id] : []))))];
    const cards = cardsFromInbox(inbox);
    // A client asked for by link but with nothing open: say so, never show someone else's case.
    const selected = want ? cards.find((c) => c.client_id === want) ?? null : cards[0] ?? null;
    const checks: Record<string, InboxCheckDetail | null> = {};
    for (const x of cards.flatMap((c) => c.check)) checks[x.snapshot_id] = await getInboxCheckDetail(tx, x.snapshot_id);
    return {
      inbox, cards, selected, checks,
      summary: selected ? (await tx<ClientSummary[]>`select * from public.v_client_summary where client_id = ${selected.client_id}`)[0] ?? null : null,
      inBank: selected ? Number((await tx<{ in_bank: number }[]>`select in_bank::float8 as in_bank from public.v_client_bank where client_id = ${selected.client_id}`)[0]?.in_bank ?? 0) : 0,
      // Trades approved by hand against this CAS (only once it is confirmed: the matching has run).
      approved: selected?.snapshot_date && !selected.check.length ? await getApprovedVsCas(tx, selected.client_id, selected.snapshot_date, selected.runIds) : [],
      wantedName: want && !selected ? ((await tx<{ full_name: string }[]>`select full_name from public.clients where id = ${want}`)[0]?.full_name ?? null) : null,
      runs: await listRuns(tx),
      docs: await listCasDocuments(tx),
      details: await getInboxRunDetails(tx, runIds),
    };
  });
  const templateSet = casPasswordTemplate() !== null;
  const at = selected ? cards.indexOf(selected) : -1;
  const nextCard = at >= 0 && cards.length > 1 ? cards[(at + 1) % cards.length] : !selected ? cards[0] ?? null : null;
  const canAdvise = actor.role !== "OPERATIONS";

  return (
    <>
      <PageHeader
        title={PAGES.casInbox}
        subtitle="Each new CAS is matched to its client and checked against the calls and SIPs. What it shows done is ticked by itself; only what needs you stays open."
      />
      {!templateSet ? (
        <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          The CAS password template (<code>CAS_PASSWORD_TEMPLATE</code>) is not configured, so password-protected files can only be opened with a password typed in the uploader.
        </p>
      ) : null}

      <BulkUploader />

      <Tabs view={view} counts={{ needs: cards.length, done: inbox.done.length, collect: inbox.collect.length }} />

      {view === "needs" ? (
        cards.length === 0 ? <p className="rounded-xl border border-dashed border-border bg-white p-6 text-center text-sm text-muted">Nothing needs you. Every CAS so far was checked by itself.</p> : (
          <div className="grid items-start gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
            <nav aria-label="Clients that need you" className="overflow-hidden rounded-xl border border-border bg-surface lg:sticky lg:top-4">
              <div className="border-b border-border px-4 py-2.5 text-[11px] font-bold uppercase tracking-[0.06em] text-amber-800">Needs you · {cards.length}</div>
              <ul className="max-h-[70vh] divide-y divide-border overflow-y-auto">
                {cards.map((c) => {
                  const on = c.client_id === selected?.client_id;
                  return (
                    <li key={c.client_id}>
                      <Link href={`/reconciliation?c=${c.client_id}`} aria-current={on ? "true" : undefined}
                        className={cn("block border-l-[3px] px-4 py-2.5 hover:bg-slate-50", on ? "border-amber-500 bg-amber-50/70" : "border-transparent")}>
                        <span className="flex items-baseline justify-between gap-2"><b className="truncate text-sm">{c.client_name}</b><span className="shrink-0 text-[11px] text-muted">{c.snapshot_date ? `CAS ${formatDate(c.snapshot_date)}` : ""}</span></span>
                        <span className="mt-1 flex flex-wrap gap-1">{reasons(c, details, checks).map((t, i) => <span key={i} className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", TONE[t.tone])}>{t.label}</span>)}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
              <div className="border-t border-border px-4 py-2 text-[11px] text-muted">CAS files that passed every check counted by themselves; they are under <Link href="/reconciliation?view=done" className="text-brand hover:underline">Done</Link>.</div>
            </nav>
            {selected ? <InboxCase c={selected} details={details} checks={checks} summary={summary} inBank={inBank} approved={approved} next={nextCard} canAdvise={canAdvise} /> : (
              <div className="rounded-xl border border-dashed border-border bg-white p-6 text-center text-sm text-muted">
                <p>Nothing is open for <b className="text-ink">{wantedName ?? "this client"}</b> in the inbox: their CAS is checked and every trade decided.</p>
                {nextCard ? <Link href={`/reconciliation?c=${nextCard.client_id}`} className="mt-3 inline-block rounded-md bg-ink px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800">Next: {nextCard.client_name} →</Link> : null}
              </div>
            )}
          </div>
        )
      ) : null}

      {view === "done" ? (
        inbox.done.length === 0 ? <p className="rounded-xl border border-dashed border-border bg-white p-6 text-center text-sm text-muted">No CAS finished in the last 30 days.</p> : (
          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface text-[13px]">
            {inbox.done.map((d) => {
              const det = d.run_id ? details[d.run_id] : undefined;
              const ticked = Boolean(det && (det.done.length || det.sip_lines_ticked));
              return (
                <li key={d.snapshot_id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
                  <Link href={`/clients/${d.client_id}`} className="w-48 truncate font-medium hover:underline">{d.client_name}</Link>
                  <span className="w-28 text-xs text-muted">CAS {formatDate(d.snapshot_date)}</span>
                  <span className="flex flex-1 flex-wrap gap-1.5 text-xs">
                    <DoneChips d={det} />
                    {d.unadvised_reviewed ? <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-slate-700">{plural(d.unadvised_reviewed, "trade")} reviewed</span> : null}
                    {!ticked && !d.unadvised_reviewed ? <span className="text-muted">Portfolio updated, no trades to match</span> : null}
                  </span>
                  {d.run_id ? <Link href={`/reconciliation/${d.run_id}`} className="text-xs text-brand hover:underline">Details</Link> : null}
                </li>
              );
            })}
          </ul>
        )
      ) : null}

      {view === "collect" ? (
        <Card>
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
      ) : null}

      {actor.role === "ADMIN" ? (
        <details className="mt-4 rounded-xl border border-border bg-surface">
          <summary className="cursor-pointer select-none px-4 py-2.5 text-sm text-muted">Admin tools</summary>
          <ActionForm action={recheckAllSipsAction} className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2.5 text-sm">
            <span className="text-muted">SIP lines of every active plan: tick those the CAS already shows started, changed or stopped since the report.</span>
            <SubmitButton size="sm" variant="outline">Re-check all SIPs from CAS</SubmitButton>
          </ActionForm>
        </details>
      ) : null}

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
                      <TD className="max-w-60 truncate text-xs"><Link className="text-brand hover:underline" href={`/cas/${d.id}`}>{casLabel(d.valuation_date)}</Link></TD>
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
