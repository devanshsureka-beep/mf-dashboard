import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Input, Select } from "@/components/ui/form";
import { ActionForm, SubmitButton } from "./action-form";
import { Money } from "./money";
import { ActionBadge, StatusBadge } from "./status-badge";
import { formatDate, humanize } from "@/lib/format";
import type { SipItem } from "@/types/domain";
import type { ActionResult } from "@/lib/actions";
import type { ReactNode } from "react";

type SipAction = (sipId: string, prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;

/** SIP plan items with inline status progression (Planned → Advised → Completed). */
export function SipTable({ rows, action, canUpdate, invested, extra }: {
  rows: SipItem[];
  action?: SipAction;
  canUpdate: boolean;
  /** Per SIP line: what its instalments have invested since it was advised (from v_sip_item_progress). */
  invested?: Record<string, { invested_amount: number; instalments: number; last_instalment_date: string | null }>;
  extra?: (s: SipItem) => ReactNode;
}) {
  return (
    <Table>
      <THead>
        <TR><TH>Action</TH><TH>Scheme</TH><TH className="text-right">Old</TH><TH className="text-right">New</TH><TH>Frequency</TH>{invested ? <TH className="text-right">Invested so far</TH> : null}<TH>Status</TH>{canUpdate && action ? <TH>Update</TH> : null}{extra ? <TH /> : null}</TR>
      </THead>
      <TBody>
        {rows.map((s) => (
          <TR key={s.id}>
            <TD><ActionBadge action={s.action} /></TD>
            <TD className="max-w-72"><div className="truncate" title={s.scheme_name}>{s.scheme_name}</div>{s.needs_review ? <span className="text-[11px] text-amber-700">security needs review</span> : null}</TD>
            <TD className="text-right"><Money value={s.old_amount} full /></TD>
            <TD className="text-right"><Money value={s.new_amount} full /></TD>
            <TD className="text-xs">{humanize(s.frequency)}{s.debit_day ? ` · day ${s.debit_day}` : ""}</TD>
            {invested ? (
              <TD className="text-right">
                {s.action === "STOP" ? <span className="text-muted">—</span> : <Money value={invested[s.id]?.invested_amount ?? 0} full />}
                {invested[s.id]?.instalments ? <div className="text-[11px] text-muted">{invested[s.id].instalments} instalment(s){invested[s.id].last_instalment_date ? ` · last ${formatDate(invested[s.id].last_instalment_date as string)}` : ""}</div> : null}
              </TD>
            ) : null}
            <TD>
              <StatusBadge status={s.status} />
              {s.completed_at ? <div className="text-[11px] text-muted">{formatDate(s.completed_at)}</div> : null}
            </TD>
            {canUpdate && action ? (
              <TD>
                {s.status === "PLANNED" || s.status === "ADVISED" ? (
                  <ActionForm action={action.bind(null, s.id)} className="flex items-center gap-1">
                    <Select name="status" className="h-8 w-32 text-xs" defaultValue={s.status === "PLANNED" ? "ADVISED" : "COMPLETED"}>
                      <option value="ADVISED">Advised</option>
                      <option value="COMPLETED">{s.action === "STOP" ? "Stopped" : "Started"}</option>
                      <option value="CANCELLED">Cancel</option>
                    </Select>
                    <Input name="note" placeholder="Note / reason" className="h-8 w-40 text-xs" />
                    <SubmitButton size="sm" variant="outline">Save</SubmitButton>
                  </ActionForm>
                ) : null}
              </TD>
            ) : null}
            {extra ? <TD>{extra(s)}</TD> : null}
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
