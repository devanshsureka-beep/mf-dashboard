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
import { moneyAfter, type moneyNow } from "@/lib/domain/waiting-approve";


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

/** Money in three layers (same rule for every client), plus where it ends up. */
export type MoneyLayers = ReturnType<typeof moneyNow> & { casDate: string | null };

/**
 * Where the client's money is: as per the last CAS, + what a person approved since (not in a CAS
 * yet), = now (estimated). Below: if every waiting call is done, and after the whole plan.
 * Sells add to the bank, buys take from it; switches move money fund to fund, so they are left out.
 */
function MoneyBox({ plan, money, sipTarget }: { plan: PlanLine[]; money: MoneyLayers; sipTarget: number }) {
  const sum = (action: string, k: "pending_amount" | "yet_to_advise_amount") => plan.filter((p) => p.action === action).reduce((s, p) => s + p[k], 0);
  const waitSell = sum("SELL", "pending_amount");
  const waitBuy = sum("BUY", "pending_amount");
  const restSell = sum("SELL", "yet_to_advise_amount");
  const restBuy = sum("BUY", "yet_to_advise_amount");
  const ifWaiting = moneyAfter(money.now, waitSell, waitBuy);
  const afterPlan = moneyAfter(ifWaiting, restSell, restBuy);
  const signed = (v: number) => (Math.abs(v) < 0.5 ? <span className="text-muted">—</span> : <>{v > 0 ? "+" : "−"}<Money value={Math.abs(v)} /></>);
  const col = (title: string, sub: React.ReactNode, funds: React.ReactNode, bank: React.ReactNode, cls: string, big = false) => (
    <div className={`space-y-1 rounded-lg px-3.5 py-3 text-[13px] ${cls}`}>
      <div className="text-[11px] font-bold uppercase tracking-wide text-muted">{title}</div>
      <div className="text-[11.5px] text-muted">{sub}</div>
      <div className="flex justify-between gap-3"><span>In funds</span><b className={`num ${big ? "text-[17px]" : ""}`}>{funds}</b></div>
      <div className="flex justify-between gap-3"><span>In bank</span><b className={`num ${big ? "text-[17px]" : ""}`}>{bank}</b></div>
    </div>
  );
  const op = (t: string) => <div className="hidden self-center text-center text-xl font-bold text-slate-400 md:block">{t}</div>;
  return (
    <section className="rounded-xl border-2 border-brand-100 bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[15px] font-semibold">Where the client&apos;s money is</h3>
        {money.hasApproved ? <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">est. = includes approved trades not yet in a CAS</span> : null}
      </div>
      <div className="mt-2.5 grid gap-2 md:grid-cols-[1fr_20px_1fr_20px_1.1fr]">
        {col("As per last CAS", `${money.casDate ? `CAS of ${formatDate(money.casDate)}` : "No CAS"} · units × today's NAV`, <Money value={money.cas.funds} />, <Money value={money.cas.bank} />, "bg-slate-50")}
        {op("+")}
        {col("Approved since (not in a CAS yet)", money.hasApproved ? <Link href="?tab=tranches#ledger" className="text-brand hover:underline">see the approved calls</Link> : "nothing approved since the CAS", signed(money.approved.funds), signed(money.approved.bank), "bg-blue-50/60")}
        {op("=")}
        {col(money.hasApproved ? "Now (estimated)" : "Now", "what you work with today", <Money value={money.now.funds} />, <span className={money.now.bank >= 0.5 ? "text-amber-700" : undefined}><Money value={money.now.bank} /></span>, "bg-emerald-50/70 ring-1 ring-emerald-200", true)}
      </div>
      <div className="mt-2.5 grid gap-2 text-[13px] md:grid-cols-2">
        <div className="rounded-lg border border-dashed border-amber-300 bg-amber-50/50 px-3.5 py-2.5">
          <b>If all waiting calls are done</b> <span className="text-muted">(sell {formatINRCompact(waitSell)} · buy {formatINRCompact(waitBuy)} advised, not approved)</span>
          <div className="mt-0.5">In funds <b className="num"><Money value={ifWaiting.funds} /></b> · In bank <b className="num"><Money value={ifWaiting.bank} /></b></div>
        </div>
        <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3.5 py-2.5">
          <b>After the whole plan</b> <span className="text-muted">(+ left to advise: sell {formatINRCompact(restSell)} · buy {formatINRCompact(restBuy)})</span>
          <div className="mt-0.5">In funds <b className="num"><Money value={afterPlan.funds} /></b> · In bank <b className="num"><Money value={afterPlan.bank} /></b> · SIPs {formatINRCompact(sipTarget)} / month</div>
        </div>
      </div>
      <p className="mt-2 text-xs text-muted">&ldquo;In bank&rdquo; is money from sells not bought back yet (plus any fresh money). Approved trades count here right away; the next CAS confirms them, and its figures win.</p>
    </section>
  );
}

export async function PortfolioTab({ client, actor, money, sipTarget, edit }: {
  client: ClientSummary; actor: Actor; money: MoneyLayers; sipTarget: number;
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
      <FundTable rows={desk.rows} totals={desk.totals} clientId={clientId} canAdvise={actor.role !== "OPERATIONS"} casDate={desk.casDate} inBank={money.now.bank}
        editHref={editable ? `/clients/${clientId}?tab=portfolio&edit=holdings` : null} />
      {editable && edit.open ? (
        <EditHoldings key={editable.snapshotId} clientId={clientId} clientName={client.full_name} data={editable} focus={edit.fund} closeHref={`/clients/${clientId}?tab=portfolio`}
          search={searchFundsAction} save={saveHoldingsAction} />
      ) : null}
      <MoneyBox plan={views.plan} money={money} sipTarget={sipTarget} />

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
                {/* No cost in the statement: no invested amount and no gain (it would just repeat the value). */}
                <TD className="text-right">{Number(s.total_invested_value) > 0 ? <Money value={s.total_invested_value} /> : <span className="text-muted">—</span>}</TD>
                <TD className="text-right"><Money value={s.total_current_value} /></TD>
                <TD className={`text-right ${s.total_gain_loss >= 0 ? "text-emerald-700" : "text-red-700"}`}>{Number(s.total_invested_value) > 0 ? <Money value={s.total_gain_loss} /> : <span className="text-muted">—</span>}</TD>
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
