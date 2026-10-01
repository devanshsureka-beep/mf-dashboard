import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Money } from "@/components/app/money";
import { StatCard } from "@/components/app/stat-card";
import { StatusBadge } from "@/components/app/status-badge";
import { SipStatusCard } from "@/components/app/sip-status-card";
import { EmptyState } from "@/components/app/page-header";
import { withUserTx, type Actor } from "@/lib/db/tx";
import { formatDate, formatDateTime, formatINRCompact, formatNav, formatUnits, humanize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { getClientSummary } from "@/services/clients";
import { latestNavRun } from "@/services/nav";
import { listRecentTransactions, listSnapshots } from "@/services/portfolio";
import { getPortfolioViews, planLineFor, type PlanLine } from "@/services/portfolio-views";
import { getSipStatus } from "@/services/sip-status";

const normFolio = (f: string | null) => (f ?? "").replace(/[^0-9a-z]/gi, "").toLowerCase();
const key = (r: { isin: string | null; security_id: string | null; scheme_name: string; folio_number: string | null }) =>
  `${r.isin ?? r.security_id ?? r.scheme_name.toLowerCase()}|${normFolio(r.folio_number)}`;

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

export async function PortfolioTab({ clientId, actor }: { clientId: string; actor: Actor }) {
  const { views, c, snapshots, txns, nav, sip } = await withUserTx(actor, async (tx) => ({
    views: await getPortfolioViews(tx, clientId),
    c: await getClientSummary(tx, clientId),
    snapshots: await listSnapshots(tx, clientId),
    txns: await listRecentTransactions(tx, clientId, 100),
    nav: await latestNavRun(tx),
    sip: await getSipStatus(tx, clientId),
  }));
  if (!views.current) return <EmptyState title="No confirmed CAS snapshot yet">Upload a CAS and confirm its extraction to see holdings.</EmptyState>;

  const cur = views.current;
  const baseRows = views.baseline?.rows ?? [];
  const baseByKey = new Map(baseRows.map((b) => [key(b), b]));
  const curKeys = new Set(cur.rows.map(key));
  const liveTotal = cur.rows.reduce((s, r) => s + r.live_value, 0);
  const casTotal = cur.rows.reduce((s, r) => s + r.cas_value, 0);
  const baseTotal = baseRows.reduce((s, r) => s + r.current_value, 0);
  const atCasNav = cur.rows.filter((r) => !r.is_live).length;
  const navDate = cur.rows.filter((r) => r.is_live).map((r) => r.nav_date).sort().at(-1) ?? null;
  const exited = baseRows.filter((b) => !curKeys.has(key(b)));
  const heldSecurities = new Set(cur.rows.map((r) => r.security_id));
  const toBuy = views.plan.filter((p) => p.side === "BUY" && !heldSecurities.has(p.security_id));

  return (
    <div className="space-y-4">
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Value today"
          value={formatINRCompact(liveTotal)}
          hint={navDate ? `Latest NAV ${formatDate(navDate)}${atCasNav ? ` · ${atCasNav} fund(s) at CAS NAV` : ""}` : "No daily NAV yet: CAS NAVs"}
        />
        <StatCard label="At onboarding" value={formatINRCompact(baseTotal)} hint={views.baseline ? `Report & CAS of ${formatDate(views.baseline.snapshot_date)} · fixed` : "No baseline CAS"} />
        <StatCard
          label="Change since onboarding"
          value={`${liveTotal - baseTotal >= 0 ? "+" : "−"}${formatINRCompact(Math.abs(liveTotal - baseTotal))}`}
          tone={liveTotal - baseTotal >= 0 ? "success" : "danger"}
          hint="Market movement and executed calls"
        />
        <StatCard
          label="Money left with client"
          value={formatINRCompact(c.money_left)}
          tone={c.money_left > 0 ? "attention" : "default"}
          hint={`Sold ${formatINRCompact(c.sell_proceeds)} − bought ${formatINRCompact(c.buy_spent)} (executed calls)`}
        />
      </section>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Current portfolio · valued at the latest NAV</CardTitle>
            <p className="mt-0.5 text-xs text-muted">
              Units from the latest CAS ({formatDate(cur.snapshot_date)}). CAS value {formatINRCompact(casTotal)}.
              {nav ? <> NAV feed: {nav.nav_date ? formatDate(nav.nav_date) : "—"}, received {formatDateTime(nav.received_at)}.</> : " The daily NAV feed has not run yet."}
            </p>
          </div>
        </CardHeader>
        <Table>
          <THead>
            <TR>
              <TH>Fund</TH><TH>Plan</TH><TH className="text-right">Units</TH><TH className="text-right">NAV</TH>
              <TH className="text-right">Value today</TH><TH className="text-right">At onboarding</TH><TH className="text-right">Change</TH>
            </TR>
          </THead>
          <TBody>
            {cur.rows.map((r) => {
              const b = baseByKey.get(key(r));
              const p = planLineFor(views.plan, r);
              const change = b ? r.live_value - b.current_value : null;
              return (
                <TR key={r.holding_id}>
                  <TD className="max-w-80">
                    <div className="truncate font-medium" title={r.scheme_name}>{r.scheme_name}</div>
                    <div className="flex flex-wrap gap-1.5 text-[11px] text-muted">
                      <span className="num">{r.folio_number ?? "—"}</span>
                      {r.plan_type ? <Badge tone={r.plan_type === "REGULAR" ? "pending" : "success"}>{r.plan_type}</Badge> : null}
                      {!b ? <Badge tone="purple">New since onboarding</Badge> : null}
                    </div>
                  </TD>
                  <TD><PlanCell p={p} liveValue={r.live_value} /></TD>
                  <TD className="text-right text-xs num">
                    {formatUnits(r.units)}
                    {b && Math.abs(b.units - r.units) > 0.001 ? <div className="text-[11px] text-muted">was {formatUnits(b.units)}</div> : null}
                  </TD>
                  <TD className="text-right text-xs num">
                    {formatNav(r.nav)}
                    <div className={cn("text-[11px]", r.is_live ? "text-muted" : "text-amber-700")}>{r.nav_date ? formatDate(r.nav_date) : "—"}{r.is_live ? "" : " · CAS"}</div>
                  </TD>
                  <TD className="text-right font-medium"><Money value={r.live_value} full /></TD>
                  <TD className="text-right text-muted"><Money value={b?.current_value ?? null} full /></TD>
                  <TD className={cn("text-right", change == null ? "" : change >= 0 ? "text-emerald-700" : "text-red-700")}><Money value={change} full /></TD>
                </TR>
              );
            })}
            {exited.map((b) => (
              <TR key={`exit-${b.id}`} className="bg-slate-50/60">
                <TD className="max-w-80">
                  <div className="truncate font-medium text-muted" title={b.scheme_name}>{b.scheme_name}</div>
                  <div className="text-[11px] text-muted num">{b.folio_number ?? "—"}</div>
                </TD>
                <TD><PlanCell p={planLineFor(views.plan, b)} /><div className="text-[11px] text-muted">Not in the latest CAS (exited)</div></TD>
                <TD className="text-right text-xs num text-muted">0<div className="text-[11px]">was {formatUnits(b.units)}</div></TD>
                <TD />
                <TD className="text-right"><Money value={0} full /></TD>
                <TD className="text-right text-muted"><Money value={b.current_value} full /></TD>
                <TD className="text-right text-red-700"><Money value={-b.current_value} full /></TD>
              </TR>
            ))}
            <TR className="bg-slate-50 font-medium">
              <TD colSpan={4}>Total ({cur.rows.length} funds)</TD>
              <TD className="text-right"><Money value={liveTotal} full /></TD>
              <TD className="text-right text-muted"><Money value={baseTotal} full /></TD>
              <TD className={cn("text-right", liveTotal - baseTotal >= 0 ? "text-emerald-700" : "text-red-700")}><Money value={liveTotal - baseTotal} full /></TD>
            </TR>
          </TBody>
        </Table>
      </Card>

      {toBuy.length ? (
        <Card>
          <CardHeader><CardTitle>To buy (not in the latest CAS yet)</CardTitle></CardHeader>
          <Table>
            <THead><TR><TH>Fund</TH><TH className="text-right">Plan</TH><TH className="text-right">Advised</TH><TH className="text-right">Executed</TH><TH className="text-right">Yet to advise</TH><TH>Status</TH></TR></THead>
            <TBody>
              {toBuy.map((p) => (
                <TR key={p.plan_item_id}>
                  <TD className="max-w-80 truncate font-medium" title={p.scheme_name}>{p.scheme_name}</TD>
                  <TD className="text-right"><Money value={p.target_amount} full /></TD>
                  <TD className="text-right"><Money value={p.advised_amount} full zeroDash /></TD>
                  <TD className="text-right text-emerald-700"><Money value={p.executed_amount} full zeroDash /></TD>
                  <TD className="text-right"><Money value={p.yet_to_advise_amount} full zeroDash /></TD>
                  <TD><StatusBadge status={p.progress_status} /></TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      ) : null}

      <SipStatusCard sip={sip} />

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
                <TD>{formatDate(s.snapshot_date)} {s.is_baseline ? <span className="ml-1 text-[11px] font-medium text-brand">ONBOARDING</span> : null}</TD>
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
