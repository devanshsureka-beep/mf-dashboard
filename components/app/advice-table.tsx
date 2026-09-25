import Link from "next/link";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Money } from "./money";
import { ActionBadge, StatusBadge } from "./status-badge";
import { formatDate, formatDateTime, formatUnits, humanize } from "@/lib/format";
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
          <TH>Executed on</TH>
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
            <TD className="whitespace-nowrap text-xs"><ExecutionTiming a={a} /></TD>
            <TD className="text-right"><Money value={a.pending_amount} className={a.pending_amount > 0 ? "text-amber-700" : "text-muted"} /></TD>
            <TD><StatusBadge status={a.status} /></TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

/** "24 Sep · same day" / "27 Sep · +1 day", with a CAS tick when the CAS proved it. */
export function ExecutionTiming({ a }: { a: Pick<AdviceItemView, "first_execution_date" | "lag_days" | "cas_verified"> }) {
  if (!a.first_execution_date) return <span className="text-muted">—</span>;
  const lag = a.lag_days ?? 0;
  return (
    <span title={a.cas_verified ? "Execution confirmed from the client's CAS" : "Recorded manually; not yet seen in a CAS"}>
      {formatDate(a.first_execution_date)}
      <span className={`ml-1 ${lag <= 1 ? "text-emerald-700" : lag <= 3 ? "text-amber-700" : "text-red-700"}`}>
        · {lag <= 0 ? "same day" : `+${lag} day${lag === 1 ? "" : "s"}`}
      </span>
      {a.cas_verified ? <span className="ml-1 text-emerald-700">✓ CAS</span> : null}
    </span>
  );
}
