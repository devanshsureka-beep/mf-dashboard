import Link from "next/link";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Money } from "./money";
import { ActionBadge, StatusBadge } from "./status-badge";
import { formatDateTime, formatUnits, humanize } from "@/lib/format";
import type { AdviceItemView } from "@/types/domain";

/** Advice call ledger table (Page 5 and Client 360 "Calls" tab). */
export function AdviceTable({ rows, showClient = true, compact = false }: { rows: AdviceItemView[]; showClient?: boolean; compact?: boolean }) {
  const full = !compact;
  return (
    <Table className="text-[13px] [&_td]:px-2 [&_th]:px-2">
      <THead>
        <TR>
          <TH>Timestamp</TH>
          {showClient ? <TH>Client</TH> : null}
          {full ? <TH>Advisor</TH> : null}
          <TH>Action</TH>
          <TH>Security</TH>
          <TH className="text-right">Amount</TH>
          {full ? <TH className="text-right">Units</TH> : null}
          {full ? <TH>Channel</TH> : null}
          <TH className="text-right">Executed</TH>
          <TH className="text-right">Pending</TH>
          <TH>Execution status</TH>
        </TR>
      </THead>
      <TBody>
        {rows.map((a) => (
          <TR key={a.id} className={a.status === "REVISED" || a.status === "CANCELLED" || a.status === "EXPIRED" ? "text-muted" : undefined}>
            <TD className="whitespace-nowrap text-xs">
              <Link href={`/advice/items/${a.id}`} className="hover:underline">{formatDateTime(a.communicated_at)}</Link>
              <div className="text-[11px] text-muted">{a.batch_code}{a.plan_item_id ? "" : " · off-plan"}</div>
            </TD>
            {showClient ? (
              <TD className="whitespace-nowrap">
                <Link href={`/clients/${a.client_id}`} className="hover:underline">{a.client_name}</Link>
                <div className="text-[11px] text-muted">{a.client_code}</div>
              </TD>
            ) : null}
            {full ? <TD className="whitespace-nowrap text-xs">{a.advisor_name ?? "—"}</TD> : null}
            <TD><ActionBadge action={a.action} /></TD>
            <TD className={compact ? "max-w-56" : "max-w-72"}>
              <Link href={`/advice/items/${a.id}`} className="block truncate hover:underline" title={a.scheme_name}>{a.scheme_name}</Link>
              {a.revises_advice_item_id ? <span className="text-[11px] text-violet-700">revision</span> : null}
            </TD>
            <TD className="text-right"><Money value={a.advised_amount} />{a.quantity_basis === "UNITS" ? <div className="text-[10px] text-muted">estimate</div> : null}</TD>
            {full ? <TD className="text-right num text-xs">{a.advised_units ? formatUnits(a.advised_units) : "—"}</TD> : null}
            {full ? <TD className="text-xs">{humanize(a.communication_channel)}</TD> : null}
            <TD className="text-right text-emerald-700"><Money value={a.executed_amount} /></TD>
            <TD className="text-right"><Money value={a.pending_amount} className={a.pending_amount > 0 ? "text-amber-700" : "text-muted"} /></TD>
            <TD><StatusBadge status={a.status} /></TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
