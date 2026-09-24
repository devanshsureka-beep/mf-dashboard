import Link from "next/link";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatDateTime, humanize } from "@/lib/format";
import type { AuditLogRow } from "@/types/domain";

const HIDDEN = new Set(["updated_at", "created_at", "extraction_payload", "status_changed_at"]);

function show(v: unknown): string {
  if (v === null || v === undefined) return "∅";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Immutable audit trail: who changed what, from what, to what, and why. */
export function AuditTable({ rows, showClient = false }: { rows: AuditLogRow[]; showClient?: boolean }) {
  return (
    <Table>
      <THead>
        <TR><TH>When</TH><TH>Who</TH>{showClient ? <TH>Client</TH> : null}<TH>Entity</TH><TH>Action</TH><TH>Change</TH><TH>Reason</TH></TR>
      </THead>
      <TBody>
        {rows.map((r) => {
          const fields = r.action === "UPDATE" ? (r.changed_fields ?? []).filter((f) => !HIDDEN.has(f)) : [];
          return (
            <TR key={r.id}>
              <TD className="whitespace-nowrap text-xs">{formatDateTime(r.occurred_at)}</TD>
              <TD className="whitespace-nowrap text-xs">{r.actor_name ?? r.actor_label ?? "system"}</TD>
              {showClient ? <TD className="whitespace-nowrap text-xs">{r.client_id ? <Link className="hover:underline" href={`/clients/${r.client_id}?tab=audit`}>{r.client_name}</Link> : "—"}</TD> : null}
              <TD className="whitespace-nowrap text-xs">{humanize(r.entity_type)}<div className="text-[10px] text-muted num">{r.entity_id?.slice(0, 8)}</div></TD>
              <TD><Badge tone={r.action === "INSERT" ? "success" : r.action === "DELETE" ? "danger" : "info"}>{r.action}</Badge></TD>
              <TD className="max-w-[520px] text-xs">
                {r.action === "UPDATE" ? (
                  <ul className="space-y-0.5">
                    {fields.slice(0, 8).map((f) => (
                      <li key={f} className="break-all">
                        <span className="font-medium">{f}</span>: <span className="text-red-700 line-through">{show(r.old_value?.[f])}</span> → <span className="text-emerald-700">{show(r.new_value?.[f])}</span>
                      </li>
                    ))}
                    {fields.length > 8 ? <li className="text-muted">+{fields.length - 8} more</li> : null}
                  </ul>
                ) : r.action === "INSERT" ? (
                  <span className="text-muted">{summary(r.new_value)}</span>
                ) : (
                  <span className="text-muted">{summary(r.old_value)}</span>
                )}
              </TD>
              <TD className="max-w-64 text-xs">{r.reason ?? <span className="text-muted">—</span>}</TD>
            </TR>
          );
        })}
      </TBody>
    </Table>
  );
}

function summary(v: Record<string, unknown> | null): string {
  if (!v) return "";
  const keys = ["client_code", "full_name", "scheme_name", "action", "advised_amount", "executed_amount", "target_amount", "status", "plan_name", "body", "communication_channel"];
  return keys.filter((k) => v[k] !== undefined && v[k] !== null).map((k) => `${k}: ${show(v[k])}`).join(" · ").slice(0, 220);
}
