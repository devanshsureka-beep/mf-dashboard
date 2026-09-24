import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { AuditTable } from "@/components/app/audit-table";
import { EmptyState } from "@/components/app/page-header";
import { withUserTx, type Actor } from "@/lib/db/tx";
import { listAuditLogs } from "@/services/audit";

export async function AuditTab({ clientId, actor }: { clientId: string; actor: Actor }) {
  const rows = await withUserTx(actor, (tx) => listAuditLogs(tx, { clientId, limit: 300 }));
  return (
    <Card>
      <CardHeader><CardTitle>Immutable audit trail (latest 300)</CardTitle></CardHeader>
      {rows.length ? <AuditTable rows={rows} /> : <CardContent><EmptyState title="No audit entries" /></CardContent>}
    </Card>
  );
}
