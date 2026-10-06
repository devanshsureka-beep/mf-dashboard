import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Money } from "@/components/app/money";
import { SipSummary } from "@/components/app/sip-summary";
import { SipStatusCard } from "@/components/app/sip-status-card";
import { SipTable } from "@/components/app/sip-table";
import { withUserTx, type Actor } from "@/lib/db/tx";
import { formatDate } from "@/lib/format";
import { getSipItems } from "@/services/plans";
import { getClientSip, getSipProgress } from "@/services/sip";
import { getSipStatus } from "@/services/sip-status";
import type { ClientSummary } from "@/types/domain";
import { setSipStatusAction } from "../actions";

/** Everything about the client's SIPs: plan lines, progress, what the CAS shows, every instalment. */
export async function SipTab({ client: c, actor }: { client: ClientSummary; actor: Actor }) {
  const d = await withUserTx(actor, async (tx) => ({
    sip: await getClientSip(tx, c.client_id),
    lines: c.active_plan_id ? await getSipItems(tx, c.active_plan_id) : [],
    progress: c.active_plan_id ? await getSipProgress(tx, c.active_plan_id) : [],
    status: await getSipStatus(tx, c.client_id),
    byFund: await tx<{ scheme_name: string; instalments: number; total: number; first_date: string; last_date: string; last_amount: number }[]>`
      select t.scheme_name, count(*)::int as instalments, sum(abs(t.amount))::float8 as total,
             min(t.transaction_date)::text as first_date, max(t.transaction_date)::text as last_date,
             (array_agg(abs(t.amount) order by t.transaction_date desc))[1]::float8 as last_amount
      from public.portfolio_transactions t
      where t.client_id = ${c.client_id} and t.transaction_type = 'SIP' and coalesce(t.amount, 0) <> 0
        and t.transaction_date >= (app.today_ist() - interval '24 months')
      group by t.scheme_name order by max(t.transaction_date) desc`,
    recent: await tx<{ date: string; scheme_name: string; amount: number; units: number | null; folio_number: string | null }[]>`
      select t.transaction_date::text as date, t.scheme_name, abs(t.amount)::float8 as amount, t.units::float8 as units, t.folio_number
      from public.portfolio_transactions t
      where t.client_id = ${c.client_id} and t.transaction_type = 'SIP' and coalesce(t.amount, 0) <> 0
      order by t.transaction_date desc limit 60`,
  }));

  return (
    <div className="space-y-3">
      <SipSummary s={d.sip} planHref={c.active_plan_id ? `/clients/${c.client_id}/plans/${c.active_plan_id}` : null} />

      <Card>
        <CardHeader>
          <CardTitle>SIP lines in the plan</CardTitle>
          {c.active_plan_id ? <Link className="text-xs text-brand hover:underline" href={`/clients/${c.client_id}/plans/${c.active_plan_id}`}>Change amounts or move lump sum ↔ SIP in the plan →</Link> : null}
        </CardHeader>
        {d.lines.length ? (
          <SipTable
            rows={d.lines}
            canUpdate={Boolean(c.active_plan_id)}
            action={setSipStatusAction.bind(null, c.client_id)}
            invested={Object.fromEntries(d.progress.map((r) => [r.sip_item_id, r]))}
          />
        ) : <CardContent><p className="text-sm text-muted">{c.active_plan_id ? "The active plan has no SIP lines." : "No active plan."}</p></CardContent>}
      </Card>

      <SipStatusCard sip={d.status} />

      <div className="grid gap-3 xl:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>SIPs running (last 24 months, from CAS)</CardTitle></CardHeader>
          {d.byFund.length ? (
            <Table className="text-[13px] [&_td]:px-2 [&_th]:px-2">
              <THead><TR><TH>Fund</TH><TH className="text-right">Last instalment</TH><TH className="text-right">Instalments</TH><TH className="text-right">Invested</TH></TR></THead>
              <TBody>
                {d.byFund.map((f) => (
                  <TR key={f.scheme_name}>
                    <TD className="max-w-72"><div className="truncate" title={f.scheme_name}>{f.scheme_name}</div><div className="text-[11px] text-muted">since {formatDate(f.first_date)}</div></TD>
                    <TD className="text-right"><Money value={f.last_amount} full /><div className="text-[11px] text-muted">{formatDate(f.last_date)}</div></TD>
                    <TD className="text-right num">{f.instalments}</TD>
                    <TD className="text-right font-medium"><Money value={f.total} /></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          ) : <CardContent><p className="text-sm text-muted">No SIP instalments in the CAS statements so far.</p></CardContent>}
        </Card>

        <Card>
          <CardHeader><CardTitle>Every SIP instalment (latest 60)</CardTitle></CardHeader>
          {d.recent.length ? (
            <div className="max-h-96 overflow-y-auto">
              <Table className="text-[13px] [&_td]:px-2 [&_th]:px-2">
                <THead><TR><TH>Date</TH><TH>Fund</TH><TH className="text-right">Amount</TH><TH className="text-right">Units</TH></TR></THead>
                <TBody>
                  {d.recent.map((r, i) => (
                    <TR key={`${r.date}-${i}`}>
                      <TD className="whitespace-nowrap text-xs">{formatDate(r.date)}</TD>
                      <TD className="max-w-64"><div className="truncate text-xs" title={r.scheme_name}>{r.scheme_name}</div></TD>
                      <TD className="text-right"><Money value={r.amount} full /></TD>
                      <TD className="text-right num text-xs">{r.units?.toFixed(3) ?? "—"}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          ) : <CardContent><p className="text-sm text-muted">None yet.</p></CardContent>}
        </Card>
      </div>
    </div>
  );
}
