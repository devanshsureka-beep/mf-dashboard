import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Input, Select } from "@/components/ui/form";
import { ActionForm, SubmitButton } from "./action-form";
import { Money } from "./money";
import { ActionBadge, StatusBadge } from "./status-badge";
import { formatDate, humanize } from "@/lib/format";
import type { SipItem } from "@/types/domain";
import type { ActionResult } from "@/lib/actions";

type SipAction = (sipId: string, prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;

/** SIP plan items with inline status progression (Planned → Advised → Completed). */
export function SipTable({ rows, action, canUpdate }: { rows: SipItem[]; action?: SipAction; canUpdate: boolean }) {
  return (
    <Table>
      <THead>
        <TR><TH>Action</TH><TH>Scheme</TH><TH className="text-right">Old</TH><TH className="text-right">New</TH><TH>Frequency</TH><TH>Status</TH>{canUpdate && action ? <TH>Update</TH> : null}</TR>
      </THead>
      <TBody>
        {rows.map((s) => (
          <TR key={s.id}>
            <TD><ActionBadge action={s.action} /></TD>
            <TD className="max-w-72"><div className="truncate" title={s.scheme_name}>{s.scheme_name}</div>{s.needs_review ? <span className="text-[11px] text-amber-700">security needs review</span> : null}</TD>
            <TD className="text-right"><Money value={s.old_amount} full /></TD>
            <TD className="text-right"><Money value={s.new_amount} full /></TD>
            <TD className="text-xs">{humanize(s.frequency)}{s.debit_day ? ` · day ${s.debit_day}` : ""}</TD>
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
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
