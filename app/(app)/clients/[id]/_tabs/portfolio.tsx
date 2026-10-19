import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Money } from "@/components/app/money";
import { StatusBadge } from "@/components/app/status-badge";
import { EmptyState } from "@/components/app/page-header";
import { withUserTx, type Actor } from "@/lib/db/tx";
import { formatDate, formatINRCompact, formatNav, formatUnits, humanize } from "@/lib/format";
import { listRecentTransactions, listSnapshots } from "@/services/portfolio";
import { getPortfolioViews, planLineFor, type PlanLine } from "@/services/portfolio-views";
import { getFundRows } from "@/services/client-desk";
import type { ClientSummary } from "@/types/domain";
import { getEditableHoldings } from "@/services/holding-corrections";
import { EditHoldings } from "@/components/app/edit-holdings";
import { saveHoldingsAction } from "../../actions";
import { searchFundsAction } from "@/app/(app)/advice/actions";
import { FundTable } from "./fund-table";


/** What the plan says for a fund, in desk language. */
function PlanCell({ p, liveValue }: { p: PlanLine | null; liveValue?: number }) {
  if (!p) return <span className="text-xs text-muted">Not in plan</span>;
  if (p.action === "RETAIN") return <Badge tone="neutral">Keep</Badge>;
  const full = p.side === "SELL" && p.current_amount != null && p.target_amount >= p.current_amount * 0.99;
  const label = p.side === "SELL" ? (full ? "Sell all" : `Trim ${formatINRCompact(p.target_amount)}`) : p.side === "BUY" ? `Buy ${formatINRCompact(p.target_amount)}` : humanize(p.action);
  const done = p.progress_status === "COMPLETED";
  return (
    <div className="space-y-0.5">
      <Badge tone={done ? "success" : p.side === "SELL" ? "danger" : p.side === "BUY" ? "info" : "neutral"}>{done ? `${label} · done` : label}</Badge>
      {p.side !== "NONE" ? (
        <div className="text-[11px] text-muted">
          {p.executed_amount > 0 ? <>Executed {formatINRCompact(p.executed_amount)}</> : p.advised_amount > 0 ? <>Advised {formatINRCompact(p.advised_amount)}</> : "Not advised yet"}
          {full && !done && liveValue != null ? <> · worth {formatINRCompact(liveValue)} today</> : null}
        </div>
      ) : null}
    </div>
  );
}

/** Where the client's money is now, and where it ends up once every tranche is done (at today's values). */
function MoneyBox({ c, plan, inFunds, inBank, sipTarget }: { c: ClientSummary; plan: PlanLine[]; inFunds: number; inBank: number; sipTarget: number }) {
  // Still to happen on the plan (waiting + left to advise, from the views): sells add to the bank, buys
  // take from it. Switches move money fund to fund, so they are left out. Start from every trade done so
  // far (money_left), not just those a CAS shows: those not in a CAS are still counted in "In funds".
  const left = (action: string) => plan.filter((p) => p.action === action).reduce((s, p) => s + p.pending_amount + p.yet_to_advise_amount, 0);
  const sellLeft = left("SELL");
  const buyLeft = left("BUY");
  const bankAfter = Math.max(0, Number(c.money_left ?? 0) + sellLeft - buyLeft);
  const total = inFunds + inBank;
  const row = (label: React.ReactNode, value: React.ReactNode, cls = "") => (
    <div className={`flex justify-between gap-3 ${cls}`}><span>{label}</span><b className="num">{value}</b></div>
  );
  return (
    <section className="rounded-xl border-2 border-brand-100 bg-surface p-4">
      <h3 className="text-[15px] font-semibold">Where the client&apos;s money is</h3>
      <div className="mt-2.5 grid gap-3 md:grid-cols-2">
        <div className="space-y-1 rounded-lg bg-slate-50 px-3.5 py-3 text-[13px]">
          <div className="text-[11px] font-bold uppercase tracking-wide text-muted">Now</div>
          {row("In mutual funds", <Money value={inFunds} />)}
          {row(<>In bank <span className="text-muted">(sold, not bought back yet)</span></>, <span className="text-amber-700"><Money value={inBank} /></span>)}
          {row("Total", <Money value={total} />, "border-t border-border pt-1")}
        </div>
        <div className="space-y-1 rounded-lg bg-slate-50 px-3.5 py-3 text-[13px]">
          <div className="text-[11px] font-bold uppercase tracking-wide text-muted">After all tranches (plan done, estimate)</div>
          {row("In mutual funds", <Money value={Math.max(0, total - bankAfter)} />)}
          {row(<>In bank <span className="text-muted">(sell {formatINRCompact(sellLeft)} more − buy {formatINRCompact(buyLeft)} more)</span></>, <Money value={bankAfter} />)}
          {row("SIPs running", <>{formatINRCompact(sipTarget)} / month</>, "border-t border-border pt-1")}
        </div>
      </div>
      <p className="mt-2 text-xs text-muted">&ldquo;In bank&rdquo; is money from sells done that has not been bought back yet (plus any fresh money). Fund values are at today&apos;s NAV; each new CAS confirms them.</p>
    </section>
  );
}

export async function PortfolioTab({ client, actor, inBank, sipTarget, edit }: {
  client: ClientSummary; actor: Actor; inBank: number; sipTarget: number;
  /** ?edit=holdings (and &fund=<security id> from a row's pencil) opens the holdings editor. */
  edit: { open: boolean; fund: string | null };
}) {
  const clientId = client.client_id;
  const canEdit = actor.role !== "OPERATIONS";
  const { views, snapshots, txns, desk, editable } = await withUserTx(actor, async (tx) => ({
    editable: canEdit ? await getEditableHoldings(tx, clientId) : null,
    desk: await getFundRows(tx, clientId),
    views: await getPortfolioViews(tx, clientId),
    snapshots: await listSnapshots(tx, clientId),
    txns: await listRecentTransactions(tx, clientId, 100),
  }));
  if (!views.current) return <EmptyState title="No confirmed CAS snapshot yet">Upload a CAS and confirm its extraction to see holdings.</EmptyState>;

  const baseRows = views.baseline?.rows ?? [];
  const baseTotal = baseRows.reduce((s, r) => s + r.current_value, 0);

  return (
    <div className="space-y-3">
      <FundTable rows={desk.rows} totals={desk.totals} clientId={clientId} canAdvise={actor.role !== "OPERATIONS"} casDate={desk.casDate} inBank={inBank}
        editHref={editable ? `/clients/${clientId}?tab=portfolio&edit=holdings` : null} />
      {editable && edit.open ? (
        <EditHoldings clientId={clientId} clientName={client.full_name} data={editable} focus={edit.fund} closeHref={`/clients/${clientId}?tab=portfolio`}
          search={searchFundsAction} save={saveHoldingsAction} />
      ) : null}
      <MoneyBox c={client} plan={views.plan} inFunds={client.live_portfolio_value ?? 0} inBank={inBank} sipTarget={sipTarget} />

      <details className="group rounded-xl border border-border bg-surface">
        <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-semibold">More detail · portfolio at onboarding, every CAS and its transactions</summary>
        <div className="space-y-4 border-t border-border p-3">

      {views.baseline ? (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Portfolio at onboarding · fixed</CardTitle>
              <p className="mt-0.5 text-xs text-muted">
                CAS of {formatDate(views.baseline.snapshot_date)}, the statement the advisory report was made from (onboarding checks that the report&apos;s values match it). These figures never change.
              </p>
            </div>
          </CardHeader>
          <Table>
            <THead><TR><TH>Fund</TH><TH>Report says</TH><TH className="text-right">Units</TH><TH className="text-right">NAV</TH><TH className="text-right">Value</TH><TH className="text-right">Weight</TH></TR></THead>
            <TBody>
              {baseRows.map((b) => (
                <TR key={b.id}>
                  <TD className="max-w-80">
                    <div className="truncate font-medium" title={b.scheme_name}>{b.scheme_name}</div>
                    <div className="text-[11px] text-muted num">{b.folio_number ?? "—"}{b.isin ? ` · ${b.isin}` : ""}</div>
                  </TD>
                  <TD><PlanCell p={planLineFor(views.plan, b)} /></TD>
                  <TD className="text-right text-xs num">{formatUnits(b.units)}</TD>
                  <TD className="text-right text-xs num">{formatNav(b.latest_nav)}<div className="text-[11px] text-muted">{b.latest_nav_date ? formatDate(b.latest_nav_date) : ""}</div></TD>
                  <TD className="text-right font-medium"><Money value={b.current_value} full /></TD>
                  <TD className="text-right text-xs num">{baseTotal > 0 ? ((b.current_value / baseTotal) * 100).toFixed(1) : "0"}%</TD>
                </TR>
              ))}
              <TR className="bg-slate-50 font-medium">
                <TD colSpan={4}>Total ({baseRows.length} funds)</TD>
                <TD className="text-right"><Money value={baseTotal} full /></TD>
                <TD className="text-right">100%</TD>
              </TR>
            </TBody>
          </Table>
        </Card>
      ) : null}

      <Card>
        <CardHeader><CardTitle>CAS history (never overwritten)</CardTitle></CardHeader>
        <Table>
          <THead><TR><TH>CAS date</TH><TH className="text-right">Invested</TH><TH className="text-right">Value</TH><TH className="text-right">Gain</TH><TH>Lines</TH><TH>Review</TH><TH /></TR></THead>
          <TBody>
            {snapshots.map((s) => (
              <TR key={s.id}>
                <TD>{formatDate(s.snapshot_date)} {s.is_baseline ? <span className="ml-1 text-[11px] font-medium text-brand">ONBOARDING</span> : null}{s.is_correction ? <span className="ml-1 text-[11px] font-medium text-amber-700" title={s.review_note ?? undefined}>CORRECTED BY HAND</span> : null}</TD>
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
      </details>
    </div>
  );
}
