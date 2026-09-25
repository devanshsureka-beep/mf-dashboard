import Link from "next/link";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { LinkButton } from "@/components/ui/button";
import { StatusBadge } from "@/components/app/status-badge";
import { EmptyState } from "@/components/app/page-header";
import { withUserTx, type Actor } from "@/lib/db/tx";
import { formatDate, formatDateTime, humanize } from "@/lib/format";
import { listCasDocuments } from "@/services/portfolio";
import { listRuns } from "@/services/reconciliation";

export async function CasTab({ clientId, actor }: { clientId: string; actor: Actor }) {
  const { docs, runs } = await withUserTx(actor, async (tx) => ({
    docs: await listCasDocuments(tx, clientId),
    runs: await listRuns(tx, { clientId }),
  }));
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>CAS statements</CardTitle>
          <LinkButton size="sm" href={`/clients/${clientId}/cas/upload`}>Upload CAS</LinkButton>
        </CardHeader>
        {docs.length === 0 ? <div className="p-4"><EmptyState title="No CAS uploaded" /></div> : (
          <Table>
            <THead><TR><TH>Uploaded</TH><TH>File</TH><TH>Source</TH><TH>Valuation date</TH><TH>Parse status</TH><TH>Snapshot</TH><TH>Issues</TH></TR></THead>
            <TBody>
              {docs.map((d) => (
                <TR key={d.id}>
                  <TD className="whitespace-nowrap text-xs">{formatDateTime(d.uploaded_at)}</TD>
                  <TD className="max-w-56 truncate text-xs">
                    <a className="hover:underline" href={`/api/documents/${d.document_id}/download`}>{d.file_name}</a>
                    {d.password_protected ? <span className="ml-1 text-muted">🔒</span> : null}
                  </TD>
                  <TD className="text-xs">{humanize(d.source)}</TD>
                  <TD className="text-xs">{formatDate(d.valuation_date)}</TD>
                  <TD><StatusBadge status={d.parse_status} /></TD>
                  <TD>{d.snapshot_id ? <Link href={`/snapshots/${d.snapshot_id}`} className="text-xs text-brand hover:underline"><StatusBadge status={d.snapshot_review_status} /></Link> : <span className="text-xs text-muted">—</span>}</TD>
                  <TD className="max-w-80 text-xs text-red-700">{d.parse_error ?? (d.parse_warnings?.length ? `${d.parse_warnings.length} warning(s)` : "")}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      <Card>
        <CardHeader><CardTitle>CAS matching runs</CardTitle></CardHeader>
        {runs.length === 0 ? <div className="p-4"><EmptyState title="No reconciliation yet">A run is created when a second CAS snapshot is confirmed.</EmptyState></div> : (
          <Table>
            <THead><TR><TH>Created</TH><TH>Compared</TH><TH>Status</TH><TH>Open items</TH><TH /></TR></THead>
            <TBody>
              {runs.map((r) => (
                <TR key={r.id}>
                  <TD className="text-xs">{formatDateTime(r.created_at)}</TD>
                  <TD className="text-xs">{formatDate(r.previous_snapshot_date)} → {formatDate(r.current_snapshot_date)}</TD>
                  <TD><StatusBadge status={r.status} /></TD>
                  <TD className="num">{r.open_matches}</TD>
                  <TD><Link className="text-xs text-brand hover:underline" href={`/reconciliation/${r.id}`}>Open</Link></TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
