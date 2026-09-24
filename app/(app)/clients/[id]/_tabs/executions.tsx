import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { ExecutionsTable } from "@/components/app/executions-table";
import { EmptyState } from "@/components/app/page-header";
import { withUserTx, type Actor } from "@/lib/db/tx";
import { listExecutions } from "@/services/executions";

export async function ExecutionsTab({ clientId, actor }: { clientId: string; actor: Actor }) {
  const rows = await withUserTx(actor, (tx) => listExecutions(tx, { clientId }));
  return (
    <Card>
      <CardHeader><CardTitle>Executions ({rows.length})</CardTitle></CardHeader>
      {rows.length ? <ExecutionsTable rows={rows} showClient={false} /> : <CardContent><EmptyState title="No executions recorded" /></CardContent>}
    </Card>
  );
}
