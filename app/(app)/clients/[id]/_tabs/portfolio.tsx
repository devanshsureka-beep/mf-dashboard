import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { HoldingsTable } from "@/components/app/holdings-table";
import { Money } from "@/components/app/money";
import { StatusBadge } from "@/components/app/status-badge";
import { EmptyState } from "@/components/app/page-header";
import { withUserTx, type Actor } from "@/lib/db/tx";
import { formatDate, formatNav, formatUnits, humanize } from "@/lib/format";
import { getHoldings, listRecentTransactions, listSnapshots } from "@/services/portfolio";

export async function PortfolioTab({ clientId, actor }: { clientId: string; actor: Actor }) {
  const { snapshots, holdings, txns } = await withUserTx(actor, async (tx) => {
    const snapshots = await listSnapshots(tx, clientId);
    const latest = snapshots.find((s) => s.review_status === "CONFIRMED");
    return {
      snapshots,
      holdings: latest ? await getHoldings(tx, latest.id) : [],
      txns: await listRecentTransactions(tx, clientId, 100),
    };
  });
  const latest = snapshots.find((s) => s.review_status === "CONFIRMED");
  if (!latest) return <EmptyState title="No confirmed CAS snapshot yet">Upload a CAS and confirm its extraction to see holdings.</EmptyState>;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Holdings as per CAS dated {formatDate(latest.snapshot_date)}</CardTitle>
          <span className="text-xs text-muted">Source: {humanize(latest.source)} · {humanize(latest.extraction_method)}</span>
        </CardHeader>
        <HoldingsTable rows={holdings} />
      </Card>

      <Card>
        <CardHeader><CardTitle>Snapshot history (never overwritten)</CardTitle></CardHeader>
        <Table>
          <THead><TR><TH>Snapshot date</TH><TH className="text-right">Invested</TH><TH className="text-right">Value</TH><TH className="text-right">Gain</TH><TH>Lines</TH><TH>Review</TH><TH /></TR></THead>
          <TBody>
            {snapshots.map((s) => (
              <TR key={s.id}>
                <TD>{formatDate(s.snapshot_date)} {s.is_baseline ? <span className="ml-1 text-[11px] font-medium text-brand">BASELINE</span> : null}</TD>
                <TD className="text-right"><Money value={s.total_invested_value} /></TD>
                <TD className="text-right"><Money value={s.total_current_value} /></TD>
                <TD className={`text-right ${s.total_gain_loss >= 0 ? "text-emerald-700" : "text-red-700"}`}><Money value={s.total_gain_loss} /></TD>
                <TD className="num text-xs">{s.holdings_count}</TD>
                <TD><StatusBadge status={s.review_status} /></TD>
                <TD><Link className="text-xs text-brand hover:underline" href={`/snapshots/${s.id}`}>Open</Link></TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>

      <Card>
        <CardHeader><CardTitle>CAS transactions (latest 100, de-duplicated)</CardTitle></CardHeader>
        {txns.length === 0 ? <CardContent><p className="text-sm text-muted">No transactions extracted.</p></CardContent> : (
          <Table>
            <THead><TR><TH>Date</TH><TH>Type</TH><TH>Scheme</TH><TH>Folio</TH><TH className="text-right">Units</TH><TH className="text-right">NAV</TH><TH className="text-right">Amount</TH><TH className="text-right">Balance units</TH></TR></THead>
            <TBody>
              {txns.map((t) => (
                <TR key={t.id}>
                  <TD className="whitespace-nowrap text-xs">{formatDate(t.transaction_date)}</TD>
                  <TD className="text-xs">{humanize(t.transaction_type)}</TD>
                  <TD className="max-w-72 truncate text-xs" title={t.scheme_name}>{t.scheme_name}</TD>
                  <TD className="text-xs num">{t.folio_number}</TD>
                  <TD className="text-right text-xs num">{t.units != null ? formatUnits(t.units) : "—"}</TD>
                  <TD className="text-right text-xs num">{formatNav(t.nav)}</TD>
                  <TD className="text-right text-xs"><Money value={t.amount} full /></TD>
                  <TD className="text-right text-xs num">{t.balance_units != null ? formatUnits(t.balance_units) : "—"}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
