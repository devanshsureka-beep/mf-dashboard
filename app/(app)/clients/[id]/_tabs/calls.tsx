import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { AdviceTable } from "@/components/app/advice-table";
import { EmptyState } from "@/components/app/page-header";
import { withUserTx, type Actor } from "@/lib/db/tx";
import { listAdviceLedger } from "@/services/advice";

export async function CallsTab({ clientId, actor }: { clientId: string; actor: Actor }) {
  const rows = await withUserTx(actor, (tx) => listAdviceLedger(tx, { clientId }));
  return (
    <Card>
      <CardHeader><CardTitle>Every call communicated to this client ({rows.length})</CardTitle></CardHeader>
      {rows.length ? <AdviceTable rows={rows} showClient={false} /> : <CardContent><EmptyState title="No calls issued yet" /></CardContent>}
    </Card>
  );
}
