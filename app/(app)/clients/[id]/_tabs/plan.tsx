import Link from "next/link";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { LinkButton } from "@/components/ui/button";
import { Money } from "@/components/app/money";
import { StatusBadge } from "@/components/app/status-badge";
import { EmptyState } from "@/components/app/page-header";
import { withUserTx, type Actor } from "@/lib/db/tx";
import { formatDate, humanize } from "@/lib/format";
import { listPlans } from "@/services/plans";

export async function PlanTab({ clientId, actor }: { clientId: string; actor: Actor }) {
  const plans = await withUserTx(actor, (tx) => listPlans(tx, clientId));
  const canAdvise = actor.role !== "OPERATIONS";
  return (
    <Card>
      <CardHeader>
        <CardTitle>Advisory plans</CardTitle>
        {canAdvise ? <LinkButton size="sm" href={`/clients/${clientId}/plans/new`}>New draft plan</LinkButton> : null}
      </CardHeader>
      {plans.length === 0 ? (
        <div className="p-4"><EmptyState title="No advisory plan yet">A plan describes the END STATE. It never implies the client has been instructed.</EmptyState></div>
      ) : (
        <Table>
          <THead>
            <TR><TH>Plan</TH><TH>Status</TH><TH>Source</TH><TH className="text-right">Target exit</TH><TH className="text-right">Exit advised</TH><TH className="text-right">Exit executed</TH><TH className="text-right">Target buy</TH><TH className="text-right">Buy advised</TH><TH className="text-right">Buy executed</TH><TH className="text-right">SIP</TH></TR>
          </THead>
          <TBody>
            {plans.map((p) => (
              <TR key={p.id}>
                <TD>
                  <Link href={`/clients/${clientId}/plans/${p.id}`} className="font-medium hover:underline">{p.plan_name}</Link>
                  <div className="text-xs text-muted">{formatDate(p.plan_date)}{p.approved_at ? ` · approved ${formatDate(p.approved_at)}` : ""}</div>
                </TD>
                <TD><StatusBadge status={p.status} /></TD>
                <TD className="text-xs">{humanize(p.extraction_source)}</TD>
                <TD className="text-right"><Money value={p.sell_target} /></TD>
                <TD className="text-right text-blue-700"><Money value={p.sell_advised} /></TD>
                <TD className="text-right text-emerald-700"><Money value={p.sell_executed} /></TD>
                <TD className="text-right"><Money value={p.buy_target} /></TD>
                <TD className="text-right text-blue-700"><Money value={p.buy_advised} /></TD>
                <TD className="text-right text-emerald-700"><Money value={p.buy_executed} /></TD>
                <TD className="text-right"><Money value={p.target_sip_value} />/mo</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}
