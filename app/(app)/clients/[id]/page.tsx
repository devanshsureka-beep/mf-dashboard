import Link from "next/link";
import { LinkButton } from "@/components/ui/button";
import { Money } from "@/components/app/money";
import { StatusBadge } from "@/components/app/status-badge";
import { DropMenu, MenuHeading, MenuItem } from "@/components/app/drop-menu";
import { getClientSip, type ClientSip } from "@/services/sip";
import { syncSipLinesQuietly } from "@/services/sip-status";
import { getClientAlerts, getPremium } from "@/services/client-record";
import { formatDate, formatINRCompact, humanize } from "@/lib/format";
import { pageData } from "@/lib/server";
import { cn, uuidOrNull } from "@/lib/utils";
import { getClientSummary } from "@/services/clients";
import { PAGES } from "@/lib/brand";
import type { ClientSummary } from "@/types/domain";
import { PortfolioTab } from "./_tabs/portfolio";
import { TranchesTab } from "./_tabs/tranches";
import { ClientFileTab } from "./_tabs/client-file";
import { TimelineTab } from "./_tabs/timeline";
import { AuditTab } from "./_tabs/audit";
import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { linkCallsToPlanAction } from "./actions";
import { ClientAllocation } from "@/components/app/client-allocation";
import { ClientValueLine } from "@/components/app/client-value-line";
import { mix } from "@/lib/domain/market-cap";
import { getClientMix } from "@/services/client-mix";

const TABS = ["portfolio", "tranches", "file", "history"] as const;
type Tab = (typeof TABS)[number];
// Links from elsewhere in the app still use the old tab names.
const LEGACY: Record<string, Tab> = {
  overview: "portfolio", plan: "tranches", calls: "tranches", executions: "tranches", cas: "tranches", sip: "tranches",
  agreements: "file", reports: "file", documents: "file", notes: "file", timeline: "history", audit: "history",
};

export async function generateMetadata(props: PageProps<"/clients/[id]">) {
  const { id } = await props.params;
  return { title: `Client ${id.slice(0, 8)}` };
}

function Alert({ href, tone, children }: { href: string; tone: "red" | "amber" | "blue"; children: React.ReactNode }) {
  const cls = { red: "bg-red-50 text-red-800 hover:bg-red-100", amber: "bg-amber-50 text-amber-900 hover:bg-amber-100", blue: "bg-brand-50 text-brand-700 hover:bg-brand-100" }[tone];
  return <Link href={href} className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium", cls)}>{children} <span aria-hidden>→</span></Link>;
}

function Figure({ label, value, hint, big, className }: { label: string; value: React.ReactNode; hint: React.ReactNode; big?: boolean; className?: string }) {
  return (
    <div className={cn("px-4 py-2.5", className)}>
      <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-muted">{label}</div>
      <div className={cn("font-semibold tracking-tight num", big ? "text-xl" : "text-lg")}>{value}</div>
      <div className="text-[11px] text-muted">{hint}</div>
    </div>
  );
}

interface RebalanceExtra {
  off_plan_sell_advised: number; off_plan_sell_executed: number; off_plan_sell_pending: number;
  off_plan_buy_advised: number; off_plan_buy_executed: number; off_plan_buy_pending: number;
}

interface RebalanceRow { name: string; hint?: string; tone: string; target: number | null; advised: number; executed: number; pending: number; remaining: number | null }

/**
 * Sell, buy and SIP: target → advised → done (CAS) → waiting → left to advise, in one card.
 * Below them, calls linked to no plan line (every plan line is Buy, Sell or Keep).
 */
function Rebalancing({ c, sip, x, closedBy, relink }: { c: ClientSummary; sip: ClientSip; x: RebalanceExtra; closedBy: string | null; relink: React.ReactNode }) {
  const rows: RebalanceRow[] = [
    { name: "Sell", tone: "text-red-700", target: c.target_sell, advised: c.advised_sell, executed: c.executed_sell, pending: c.pending_sell, remaining: c.yet_to_advise_sell },
    { name: "Buy", tone: "text-blue-700", target: c.target_buy, advised: c.advised_buy, executed: c.executed_buy, pending: c.pending_buy, remaining: c.yet_to_advise_buy },
    { name: "SIP / month", tone: "text-violet-700", target: sip.sip_monthly_target, advised: sip.sip_monthly_advised, executed: sip.sip_monthly_started, pending: Math.max(0, sip.sip_monthly_advised - sip.sip_monthly_started), remaining: sip.sip_monthly_yet_to_advise },
  ];
  if (x.off_plan_sell_advised > 0.5) {
    rows.push({ name: "Sold, not in plan", tone: "text-slate-600", target: null, advised: x.off_plan_sell_advised, executed: x.off_plan_sell_executed, pending: x.off_plan_sell_pending, remaining: null, hint: "Calls linked to no plan line" });
  }
  if (x.off_plan_buy_advised > 0.5) {
    rows.push({ name: "Bought, not in plan", tone: "text-slate-600", target: null, advised: x.off_plan_buy_advised, executed: x.off_plan_buy_executed, pending: x.off_plan_buy_pending, remaining: null, hint: "Calls linked to no plan line" });
  }
  const offPlan = x.off_plan_sell_advised + x.off_plan_buy_advised > 0.5;
  return (
    <section className="mt-3 rounded-xl border border-border bg-surface px-4 py-3">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[13px] font-semibold">Rebalancing progress</h2>
        <div className="flex items-center gap-2">
          {offPlan ? relink : null}
          {closedBy ? <span className="text-xs text-muted">{closedBy}</span> : null}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-[13px]">
          <thead className="text-right text-[10.5px] font-semibold uppercase tracking-wide text-muted">
            <tr><th /><th className="px-2 py-1">Target</th><th className="px-2 py-1">Advised</th><th className="px-2 py-1">Done</th><th className="px-2 py-1">Waiting</th><th className="px-2 py-1">Left to advise</th><th className="w-56 px-2 py-1 text-left">Progress</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const target = r.target ?? 0;
              const pct = target > 0 ? Math.min(100, Math.round((r.executed / target) * 100)) : 0;
              const adv = target > 0 ? Math.min(100, Math.round((r.advised / target) * 100)) : 0;
              return (
                <tr key={r.name} className="border-t border-border text-right num">
                  <td className={cn("py-1.5 text-left font-semibold", r.tone)} title={r.hint}>
                    {r.name}
                    {r.hint ? <div className="text-[10.5px] font-normal text-muted">{r.hint}</div> : null}
                  </td>
                  <td className="px-2 py-1.5 font-semibold">{r.target == null ? "—" : formatINRCompact(r.target)}</td>
                  <td className="px-2 py-1.5 text-blue-700">{formatINRCompact(r.advised)}</td>
                  <td className="px-2 py-1.5 text-emerald-700">{formatINRCompact(r.executed)}</td>
                  <td className={cn("px-2 py-1.5", r.pending > 0.5 ? "font-medium text-amber-700" : "text-muted")}>{formatINRCompact(r.pending)}</td>
                  <td className="px-2 py-1.5 font-semibold">{r.remaining == null ? "—" : formatINRCompact(r.remaining)}</td>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-2">
                      <div className="relative h-1.5 flex-1 rounded-full bg-slate-100" title={`Advised ${adv}% · done ${pct}%`}>
                        <div className="absolute inset-y-0 left-0 rounded-full bg-blue-200" style={{ width: `${adv}%` }} />
                        <div className="absolute inset-y-0 left-0 rounded-full bg-emerald-500" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="w-9 text-[11px] text-muted">{target > 0 ? `${pct}%` : "—"}</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const EMPTY_EXTRA: RebalanceExtra = {
  off_plan_sell_advised: 0, off_plan_sell_executed: 0, off_plan_sell_pending: 0,
  off_plan_buy_advised: 0, off_plan_buy_executed: 0, off_plan_buy_pending: 0,
};

export default async function Client360(props: PageProps<"/clients/[id]">) {
  const { id } = await props.params;
  const sp = await props.searchParams;
  const raw = String(sp.tab ?? "");
  const tab: Tab = (TABS as readonly string[]).includes(raw) ? (raw as Tab) : LEGACY[raw] ?? "portfolio";
  const str = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : null);
  const { c, bank, extra, unchecked, sip, picture, premium, alerts, casCount, lastCas, actor } = await pageData(async (tx, who) => ({
    // SIP lines the CAS already shows done (started / changed / stopped since the report) are ticked first (advisors / admins).
    synced: who.role === "OPERATIONS" ? 0 : await syncSipLinesQuietly(tx, id),
    c: await getClientSummary(tx, id),
    extra: (await tx<RebalanceExtra[]>`
      select off_plan_sell_advised::float8 as off_plan_sell_advised, off_plan_sell_executed::float8 as off_plan_sell_executed, off_plan_sell_pending::float8 as off_plan_sell_pending,
             off_plan_buy_advised::float8 as off_plan_buy_advised, off_plan_buy_executed::float8 as off_plan_buy_executed, off_plan_buy_pending::float8 as off_plan_buy_pending
      from public.v_client_rebalance_extra where client_id = ${id}`)[0],
    bank: (await tx<{ in_bank: number; fresh_money: number; cash_at_onboarding: number }[]>`
      select in_bank::float8 as in_bank, fresh_money::float8 as fresh_money, cash_at_onboarding::float8 as cash_at_onboarding
      from public.v_client_bank where client_id = ${id}`)[0] ?? { in_bank: 0, fresh_money: 0, cash_at_onboarding: 0 },
    sip: await getClientSip(tx, id),
    picture: await getClientMix(tx, id),
    premium: await getPremium(tx, id),
    alerts: await getClientAlerts(tx, id),
    // Confirmed CAS from onboarding on: CAS n closes tranche n.
    lastCas: (await tx<{ d: string | null }[]>`
      select max(snapshot_date)::text as d from public.portfolio_snapshots
      where client_id = ${id} and review_status = 'CONFIRMED' and not is_correction`)[0]?.d ?? null,
    casCount: Number((await tx<{ n: number }[]>`
      select count(*)::int as n from public.portfolio_snapshots
      where client_id = ${id} and review_status = 'CONFIRMED' and not is_correction
        and snapshot_date >= coalesce((select snapshot_date from public.portfolio_snapshots where client_id = ${id} and is_baseline limit 1), '-infinity'::date)`)[0]?.n ?? 0),
    // A CAS read but not yet checked: its holdings count only once confirmed.
    unchecked: (await tx<{ cas_document_id: string; snapshot_date: string }[]>`
      select s.cas_document_id, s.snapshot_date::text as snapshot_date from public.portfolio_snapshots s
      where s.client_id = ${id} and s.review_status = 'PENDING_REVIEW' and s.cas_document_id is not null
        and s.snapshot_date >= coalesce((select max(snapshot_date) from public.portfolio_snapshots
                                         where client_id = ${id} and review_status = 'CONFIRMED' and not is_correction), '-infinity'::date)
      order by s.snapshot_date desc, s.created_at desc limit 1`)[0] ?? null,
  }));
  const canAdvise = actor.role !== "OPERATIONS";
  const isAdmin = actor.role === "ADMIN";
  // Money from sells not yet bought back sits in the client's bank: it is still theirs.
  const inFunds = c.live_portfolio_value ?? 0;
  const inBank = bank.in_bank;
  const fresh = bank.fresh_money;
  const valueToday = inFunds + inBank;
  // Trades done before onboarding (from a CAS newer than the report) left cash that was already the client's.
  const startValue = (c.initial_portfolio_value ?? 0) + fresh + bank.cash_at_onboarding;
  const change = valueToday - startValue;
  const changePct = startValue ? (change / startValue) * 100 : null;
  const thisMonth = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit" }).format(new Date());
  const remaining = c.yet_to_advise_sell + c.yet_to_advise_buy;
  // Premium and agreement in one chip.
  const docGap = [
    premium.premium_status !== "ACTIVE" ? `Premium ${premium.premium_status === "EXPIRED" ? "expired" : premium.premium_status === "PAID" ? "period not recorded" : "not recorded"}`
      : premium.renewal_due ? `Premium renewal due${premium.paid_until ? ` ${formatDate(premium.paid_until)}` : ""}` : null,
    premium.agreement_status !== "VALID" ? `agreement ${premium.agreement_status === "EXPIRED" ? "expired" : "missing"}` : null,
  ].filter(Boolean).join(" · ");
  const openTranche = Math.max(1, casCount);
  const tabHref = (t: Tab, extra = "") => `/clients/${id}?tab=${t}${extra}`;
  const LABEL: Record<Tab, string> = {
    portfolio: "Portfolio & plan", tranches: "Tranches & SIPs",
    file: alerts.followUpsDue ? `Client file & notes · ${alerts.followUpsDue}` : "Client file & notes", history: "History",
  };

  return (
    <>
      <div className="mb-1.5 flex items-center gap-2 text-xs text-muted">
        <Link href="/clients" className="hover:text-ink hover:underline">{PAGES.clients}</Link>
        <span aria-hidden>/</span>
        <span className="num">{c.client_code}</span>
      </div>

      {/* Who, what they are worth, what needs doing */}
      <section className="rounded-xl border border-border bg-surface shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
        <div className="flex flex-col gap-4 p-4 lg:flex-row lg:items-stretch">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
              {c.full_name}
              <span className="rounded-md bg-brand-50 px-2 py-0.5 font-mono text-xs font-semibold text-brand-700 ring-1 ring-brand-100" title="Client ID">{c.client_code}</span>
              <StatusBadge status={c.status} />
            </h1>
            <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[13px] text-slate-700">
              <span>Advisor <b className="font-semibold text-ink">{c.advisor_name ?? "—"}</b></span>
              {c.risk_profile || c.goal ? <span>{[c.risk_profile ? humanize(c.risk_profile) : null, c.goal].filter(Boolean).join(" · ")}</span> : null}
              <span>Onboarded {formatDate(c.onboarding_date)}</span>
              {c.phone ? <span className="num">{c.phone}</span> : null}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {c.active_plan_id && remaining > 0.5 ? <Alert href={tabHref("tranches")} tone="blue">Tranche {openTranche} · {formatINRCompact(remaining)} left to advise</Alert> : null}
              {c.pending_total >= 0.5 ? <Alert href={tabHref("tranches", "&side=PENDING#ledger")} tone="amber">{formatINRCompact(c.pending_total)} waiting for client</Alert> : null}
              {alerts.unadvised ? (
                <Alert href={alerts.unadvised.runs > 1 ? tabHref("tranches") : `/reconciliation/${alerts.unadvised.runId}`} tone="red">
                  {alerts.unadvised.count} unadvised trade(s) · {formatINRCompact(alerts.unadvised.amount)}
                </Alert>
              ) : null}
              {unchecked ? <Alert href={`/cas/${unchecked.cas_document_id}`} tone="amber">CAS of {formatDate(unchecked.snapshot_date)} to check</Alert> : null}
              {alerts.reportQuestions ? <Alert href={`/clients/${id}/plans/${alerts.reportQuestions.planId}#questions`} tone="amber">{alerts.reportQuestions.n} question(s) on the report to answer</Alert> : null}
              {alerts.draftPlan ? <Alert href={`/clients/${id}/plans/${alerts.draftPlan.id}`} tone="blue">{alerts.draftPlan.kind === "ADDITIONAL" ? "Additional-investment" : "Draft"} plan to approve</Alert> : null}
              {!c.active_plan_id ? <Alert href={canAdvise ? `/clients/${id}/plans/new` : tabHref("tranches")} tone="amber">No active plan</Alert> : null}
              {alerts.followUpsDue ? <Alert href={tabHref("file", "#notes")} tone="amber">{alerts.followUpsDue} follow-up(s) due</Alert> : null}
              {docGap ? <Alert href={tabHref("file", premium.agreement_status !== "VALID" && premium.premium_status === "ACTIVE" ? "&open=agreement#agreement" : "&open=premium#premium")} tone={premium.renewal_due && premium.premium_status === "ACTIVE" && premium.agreement_status === "VALID" ? "amber" : "red"}>{docGap}</Alert> : null}
            </div>
            <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
              {canAdvise ? (
                <DropMenu label="Issue call" primary>
                  <MenuItem href={`/advice/new?client=${id}&side=SELL`} hint={`${formatINRCompact(c.yet_to_advise_sell)} of sells left to advise`}><b className="text-red-700">Sell call</b></MenuItem>
                  <MenuItem href={`/advice/new?client=${id}&side=BUY`} hint={`${formatINRCompact(c.yet_to_advise_buy)} of buys left to advise`}><b className="text-blue-700">Buy call</b></MenuItem>
                  <MenuItem href={tabHref("tranches", "#sip-lines")} hint={`Start / stop / change a SIP · ${formatINRCompact(sip.sip_monthly_yet_to_advise)}/mo left`}><b className="text-violet-700">SIP</b></MenuItem>
                </DropMenu>
              ) : null}
              <LinkButton href={`/clients/${id}/cas/upload`} variant="outline" size="sm">Upload CAS</LinkButton>
              {c.active_plan_id ? <LinkButton href={`/clients/${id}/plans/${c.active_plan_id}`} variant="outline" size="sm">Open plan</LinkButton> : null}
              <DropMenu label="More">
                <MenuHeading>For this client</MenuHeading>
                <MenuItem href={tabHref("file", "#add-note")}>Add note / follow-up</MenuItem>
                <MenuItem href={`/clients/${id}/report?month=${thisMonth}`}>Monthly report · {new Intl.DateTimeFormat("en-IN", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${thisMonth}-01T00:00:00Z`))}</MenuItem>
                <MenuItem href={`/api/clients/${id}/export`} download hint="All CAS, reports, agreements, calls, executions and the audit log">Download everything (ZIP)</MenuItem>
                <MenuHeading>Records</MenuHeading>
                <MenuItem href={tabHref("file", "&open=premium#premium")}>Record premium payment</MenuItem>
                <MenuItem href={tabHref("file", "&open=agreement#agreement")}>Add agreement</MenuItem>
                <MenuItem href={`/clients/${id}/documents/upload`}>Upload document (KYC, proof, other)</MenuItem>
                {canAdvise ? <MenuItem href={tabHref("file", "&open=details#details")}>Edit client details</MenuItem> : null}
                {isAdmin ? (
                  <>
                    <MenuHeading>Admin only</MenuHeading>
                    <MenuItem href={tabHref("tranches", "&view=all#ledger")} hint="When a CAS is wrong or missing: open the call, corrections are on its page">Correct a call / execution</MenuItem>
                    {c.active_plan_id ? <MenuItem href={`/clients/${id}/plans/${c.active_plan_id}`}>Correct a plan line</MenuItem> : null}
                    <MenuItem href={tabHref("file", "&open=details#advisor")}>Reassign advisor</MenuItem>
                    <MenuItem href={`/clients?q=${encodeURIComponent(c.client_code)}`} danger hint="Tick the client on the list, give a reason">Delete client</MenuItem>
                  </>
                ) : null}
              </DropMenu>
              <span className="text-[11.5px] text-muted">Done updates from each new CAS</span>
            </div>
          </div>
          <div className="grid shrink-0 grid-cols-2 self-start overflow-hidden rounded-lg bg-slate-50 ring-1 ring-border sm:w-[360px]">
            <Figure label="Value today" value={<Money value={valueToday} />} big hint={`${c.live_nav_date ? `NAV ${formatDate(c.live_nav_date)}` : "CAS NAV"} · funds + bank`} />
            <Figure label="Since onboarding" className="border-l border-border" value={<span className={change >= 0 ? "text-emerald-700" : "text-red-700"}>{change >= 0 ? "+" : "−"}{formatINRCompact(Math.abs(change))}</span>}
              hint={<>from <Money value={startValue} />{changePct != null ? ` (${changePct >= 0 ? "+" : ""}${changePct.toFixed(1)}%)` : ""}</>} />
            <Figure label="In funds" className="border-t border-border" value={<Money value={inFunds} />} hint="holding in MFs" />
            <Figure label="In bank" className="border-l border-t border-border" value={<span className={inBank >= 0.5 ? "text-amber-700" : undefined}><Money value={inBank} /></span>} hint="sold, not bought back" />
          </div>
        </div>
      </section>

      {/* The portfolio picture: where the money sits now and after the plan, and its value since onboarding. */}
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <ClientAllocation hasPlan={picture.planDeltas.length > 0}
          views={{ cap: mix(picture.holdings, picture.planDeltas, "cap"), class: mix(picture.holdings, picture.planDeltas, "class"), amc: mix(picture.holdings, picture.planDeltas, "amc") }} />
        <ClientValueLine points={picture.history} change={change} changePct={changePct} />
      </div>

      <Rebalancing
        c={c} sip={sip} x={extra ?? EMPTY_EXTRA}
        closedBy={casCount > 1 ? `Tranche ${casCount - 1} closed by CAS ${formatDate(lastCas)}` : null}
        relink={isAdmin && c.active_plan_id ? (
          <ActionForm action={linkCallsToPlanAction.bind(null, id)} className="inline">
            <SubmitButton size="sm" variant="outline" confirm="Link the calls outside the plan to the plan line of the same fund (Sell or Buy)?">Link calls to plan</SubmitButton>
          </ActionForm>
        ) : null}
      />

      <nav className="sticky top-0 z-20 mt-3 flex gap-0.5 overflow-x-auto border-b border-border bg-background/95 backdrop-blur" aria-label="Client sections">
        {TABS.map((t) => (
          <Link
            key={t}
            href={tabHref(t)}
            aria-current={t === tab ? "page" : undefined}
            className={cn(
              "-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-[13.5px] transition-colors",
              t === tab ? "border-brand font-semibold text-brand" : "border-transparent text-slate-600 hover:border-border hover:text-ink",
            )}
          >
            {LABEL[t]}
            {t === "tranches" && c.open_calls > 0 ? <span className="ml-1 rounded-full bg-orange-100 px-1.5 text-[10px] font-medium text-orange-800">{c.open_calls} waiting</span> : null}
            {t === "tranches" && alerts.unadvised ? <span className="ml-1 rounded-full bg-red-100 px-1.5 text-[10px] text-red-700">{alerts.unadvised.count}</span> : null}
          </Link>
        ))}
      </nav>
      <div className="mt-3">
        {tab === "portfolio" && <PortfolioTab client={c} actor={actor} inBank={inBank} sipTarget={sip.sip_monthly_target} edit={{ open: str("edit") === "holdings", fund: uuidOrNull(str("fund")) }} />}
        {tab === "tranches" && <TranchesTab client={c} actor={actor} view={str("view") ?? (str("side") === "PENDING" ? "waiting" : null)} />}
        {tab === "file" && <ClientFileTab client={c} actor={actor} docType={str("doc")} open={str("open")} />}
        {tab === "history" && (
          <div className="space-y-2">
            <div className="flex gap-1.5 text-xs">
              {[["timeline", "Timeline"], ["audit", "Audit log (every field change)"]].map(([v, l]) => (
                <Link key={v} href={tabHref("history", v === "audit" ? "&view=audit" : "")}
                  className={cn("rounded-full px-2.5 py-1 ring-1", (str("view") === "audit") === (v === "audit") ? "bg-ink text-white ring-ink" : "bg-white ring-border hover:bg-slate-50")}>{l}</Link>
              ))}
            </div>
            {str("view") === "audit" || raw === "audit" ? <AuditTab clientId={id} actor={actor} /> : <TimelineTab clientId={id} actor={actor} kind={str("kind")} />}
          </div>
        )}
      </div>
    </>
  );
}
