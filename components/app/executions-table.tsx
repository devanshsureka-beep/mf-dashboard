import Link from "next/link";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Money } from "./money";
import { ActionBadge, StatusBadge } from "./status-badge";
import { formatDate, formatDateTime, formatUnits } from "@/lib/format";
import type { ExecutionRow } from "@/types/domain";

export function ExecutionsTable({ rows, showClient = true, showSecurity = true }: { rows: ExecutionRow[]; showClient?: boolean; showSecurity?: boolean }) {
  return (
    <Table>
      <THead>
        <TR>
          <TH>Execution date</TH>
          {showClient ? <TH>Client</TH> : null}
          {showSecurity ? <TH>Call</TH> : null}
          <TH className="text-right">Amount</TH>
          <TH className="text-right">Units</TH>
          <TH>Verification</TH>
          <TH>Status</TH>
          <TH>Recorded</TH>
          <TH>Notes</TH>
        </TR>
      </THead>
      <TBody>
        {rows.map((e) => (
          <TR key={e.id} className={e.status === "CANCELLED" || e.status === "REJECTED" ? "text-muted line-through decoration-gray-300" : undefined}>
            <TD className="whitespace-nowrap">{formatDate(e.execution_date)}{e.execution_time ? <span className="text-xs text-muted"> {e.execution_time.slice(0, 5)}</span> : null}</TD>
            {showClient ? <TD className="whitespace-nowrap"><Link href={`/clients/${e.client_id}`} className="hover:underline">{e.client_name}</Link></TD> : null}
            {showSecurity ? (
              <TD className="max-w-64">
                <Link href={`/advice/items/${e.advice_item_id}`} className="flex items-center gap-1.5 hover:underline">
                  {e.action ? <ActionBadge action={e.action} /> : null}
                  <span className="truncate" title={e.scheme_name}>{e.scheme_name}</span>
                </Link>
              </TD>
            ) : null}
            <TD className="text-right"><Money value={e.executed_amount} full /></TD>
            <TD className="text-right num text-xs">{e.executed_units ? formatUnits(e.executed_units) : "—"}</TD>
            <TD>
              <StatusBadge status={e.verification_type} />
              {e.cas_verified_at && e.verification_type !== "CAS_VERIFIED" ? <div className="mt-0.5"><StatusBadge status="CAS_VERIFIED" label="+ CAS verified" /></div> : null}
            </TD>
            <TD><StatusBadge status={e.status} />{e.status_reason && (e.status === "CANCELLED" || e.status === "REJECTED") ? <div className="text-[11px] text-muted no-underline">{e.status_reason}</div> : null}</TD>
            <TD className="whitespace-nowrap text-xs text-muted">{formatDateTime(e.created_at)}<div>{e.created_by_name ?? ""}</div></TD>
            <TD className="max-w-56 text-xs text-muted">{e.notes}</TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
