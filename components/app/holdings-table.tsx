import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Money } from "./money";
import { formatNav, formatUnits } from "@/lib/format";
import type { HoldingRow } from "@/types/domain";
import { Badge } from "@/components/ui/badge";

export function HoldingsTable({ rows }: { rows: HoldingRow[] }) {
  const total = rows.reduce((s, h) => s + h.current_value, 0);
  const cost = rows.reduce((s, h) => s + (h.cost_value ?? 0), 0);
  return (
    <Table>
      <THead>
        <TR>
          <TH>Scheme</TH><TH>Folio</TH><TH>ISIN</TH><TH className="text-right">Units</TH><TH className="text-right">NAV</TH>
          <TH className="text-right">Cost</TH><TH className="text-right">Value</TH><TH className="text-right">Gain</TH><TH className="text-right">Weight</TH>
        </TR>
      </THead>
      <TBody>
        {rows.map((h) => {
          const gain = h.cost_value != null ? h.current_value - h.cost_value : null;
          return (
            <TR key={h.id}>
              <TD className="max-w-80">
                <div className="truncate font-medium" title={h.scheme_name}>{h.scheme_name}</div>
                <div className="flex gap-1.5 text-[11px] text-muted">
                  {h.amc}{h.category ? ` · ${h.category}` : ""}
                  {h.plan_type ? <Badge tone={h.plan_type === "REGULAR" ? "pending" : "success"}>{h.plan_type}</Badge> : null}
                </div>
              </TD>
              <TD className="text-xs num">{h.folio_number ?? "—"}</TD>
              <TD className="text-xs num text-muted">{h.isin ?? "—"}</TD>
              <TD className="text-right text-xs num">{formatUnits(h.units)}</TD>
              <TD className="text-right text-xs num">{formatNav(h.latest_nav)}</TD>
              <TD className="text-right"><Money value={h.cost_value} full /></TD>
              <TD className="text-right font-medium"><Money value={h.current_value} full /></TD>
              <TD className={`text-right ${gain == null ? "" : gain >= 0 ? "text-emerald-700" : "text-red-700"}`}><Money value={gain} full /></TD>
              <TD className="text-right text-xs num">{total > 0 ? ((h.current_value / total) * 100).toFixed(1) : "0"}%</TD>
            </TR>
          );
        })}
        <TR className="bg-gray-50 font-medium">
          <TD colSpan={5}>Total ({rows.length} lines)</TD>
          <TD className="text-right"><Money value={cost} full /></TD>
          <TD className="text-right"><Money value={total} full /></TD>
          <TD className={`text-right ${total - cost >= 0 ? "text-emerald-700" : "text-red-700"}`}><Money value={total - cost} full /></TD>
          <TD className="text-right">100%</TD>
        </TR>
      </TBody>
    </Table>
  );
}
