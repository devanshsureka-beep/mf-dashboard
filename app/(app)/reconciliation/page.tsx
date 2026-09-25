import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/form";
import { Money } from "@/components/app/money";
import { StatusBadge } from "@/components/app/status-badge";
import { EmptyState, PageHeader } from "@/components/app/page-header";
import { formatDate, formatDateTime, humanize } from "@/lib/format";
import { pageData } from "@/lib/server";
import { listClientSummaries } from "@/services/clients";
import { listCasDocuments } from "@/services/portfolio";
import { listRuns } from "@/services/reconciliation";

export const metadata = { title: "CAS matching" };

export default async function ReconciliationPage() {
  const { runs, docs, clients } = await pageData(async (tx) => ({
    runs: await listRuns(tx),
    docs: await listCasDocuments(tx),
    clients: await listClientSummaries(tx),
  }));
  return (
    <>
      <PageHeader title="CAS matching" subtitle="Each new CAS is compared with the calls: transactions that clearly match a call are confirmed as executed automatically; everything else waits for your decision." />

      <Card className="mb-4">
        <CardHeader><CardTitle>Upload a new CAS</CardTitle></CardHeader>
        <CardContent>
          <form action="/reconciliation/upload" method="get" className="flex flex-wrap gap-2">
            <Select name="client" required defaultValue="" className="w-80">
              <option value="" disabled>Choose client…</option>
              {clients.map((c) => <option key={c.client_id} value={c.client_id}>{c.full_name} · {c.client_code}{c.latest_cas_date ? ` · last CAS ${formatDate(c.latest_cas_date)}` : ""}</option>)}
            </Select>
            <Button type="submit">Continue to upload</Button>
          </form>
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardHeader><CardTitle>Reconciliation runs</CardTitle></CardHeader>
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
        <CardHeader><CardTitle>CAS documents</CardTitle></CardHeader>
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
    </>
  );
}
