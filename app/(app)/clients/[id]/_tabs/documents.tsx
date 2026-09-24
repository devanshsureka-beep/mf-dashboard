import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { LinkButton } from "@/components/ui/button";
import { StatusBadge } from "@/components/app/status-badge";
import { EmptyState } from "@/components/app/page-header";
import { withUserTx, type Actor } from "@/lib/db/tx";
import { formatDateTime, humanize } from "@/lib/format";
import { listDocuments } from "@/services/documents";

export async function DocumentsTab({ clientId, actor }: { clientId: string; actor: Actor }) {
  const docs = await withUserTx(actor, (tx) => listDocuments(tx, clientId));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Documents (private storage, signed links expire in 60 seconds)</CardTitle>
        <div className="flex gap-2">
          <LinkButton size="sm" variant="outline" href={`/clients/${clientId}/documents/upload`}>Upload document</LinkButton>
        </div>
      </CardHeader>
      {docs.length === 0 ? <div className="p-4"><EmptyState title="No documents" /></div> : (
        <Table>
          <THead><TR><TH>Uploaded</TH><TH>Type</TH><TH>File</TH><TH>Size</TH><TH>Status</TH><TH>By</TH><TH>SHA-256</TH></TR></THead>
          <TBody>
            {docs.map((d) => (
              <TR key={d.id}>
                <TD className="whitespace-nowrap text-xs">{formatDateTime(d.created_at)}</TD>
                <TD className="text-xs">{humanize(d.document_type)}</TD>
                <TD className="max-w-72 truncate text-xs"><a className="text-brand hover:underline" href={`/api/documents/${d.id}/download`}>{d.file_name}</a></TD>
                <TD className="text-xs num">{d.size_bytes ? `${Math.round(d.size_bytes / 1024)} KB` : "—"}</TD>
                <TD>{d.parse_status !== "NOT_APPLICABLE" ? <StatusBadge status={d.parse_status} /> : null}</TD>
                <TD className="text-xs">{d.uploader_name ?? "integration"}</TD>
                <TD className="text-[10px] text-muted num">{d.sha256.slice(0, 12)}…</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}
