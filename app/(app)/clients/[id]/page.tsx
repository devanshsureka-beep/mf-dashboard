import Link from "next/link";
import { LinkButton } from "@/components/ui/button";
import { Money } from "@/components/app/money";
import { StatusBadge } from "@/components/app/status-badge";
import { DropMenu, MenuHeading, MenuItem } from "@/components/app/drop-menu";
import { getClientSip, type ClientSip } from "@/services/sip";
import { getClientAlerts, getPremium } from "@/services/client-record";
import { formatDate, formatINRCompact, humanize } from "@/lib/format";
import { pageData } from "@/lib/server";
import { cn } from "@/lib/utils";
import { getClientSummary } from "@/services/clients";
import { PAGES } from "@/lib/brand";
import type { ClientSummary } from "@/types/domain";
import { PortfolioTab } from "./_tabs/portfolio";
import { TranchesTab } from "./_tabs/tranches";
import { SipTab } from "./_tabs/sip";
import { ClientFileTab } from "./_tabs/client-file";
import { TimelineTab } from "./_tabs/timeline";
import { AuditTab } from "./_tabs/audit";

const TABS = ["portfolio", "tranches", "sip", "file", "history"] as const;
type Tab = (typeof TABS)[number];
// Links from elsewhere in the app still use the old tab names.
const LEGACY: Record<string, Tab> = {
  overview: "portfolio", plan: "tranches", calls: "tranches", executions: "tranches", cas: "tranches",
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

/** Sell, buy and SIP: target → advised → done (CAS) → waiting → left to advise, in one card. */
function Rebalancing({ c, sip, closedBy }: { c: ClientSummary; sip: ClientSip; closedBy: string | null }) {
  const rows = [
    { name: "Sell", tone: "text-red-700", target: c.target_sell, advised: c.advised_sell, executed: c.executed_sell, pending: c.pending_sell, remaining: c.yet_to_advise_sell },
    { name: "Buy", tone: "text-blue-700", target: c.target_buy, advised: c.advised_buy, executed: c.executed_buy, pending: c.pending_buy, remaining: c.yet_to_advise_buy },
    { name: "SIP / month", tone: "text-violet-700", target: sip.sip_monthly_target, advised: sip.sip_monthly_advised, executed: sip.sip_monthly_started, pending: Math.max(0, sip.sip_monthly_advised - sip.sip_monthly_started), remaining: sip.sip_monthly_yet_to_advise },
  ];
  return (
    <section className="mt-3 rounded-xl border border-border bg-surface px-4 py-3">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[13px] font-semibold">Rebalancing progress</h2>
        {closedBy ? <span className="text-xs text-muted">{closedBy}</span> : null}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-[13px]">
          <thead className="text-right text-[10.5px] font-semibold uppercase tracking-wide text-muted">
            <tr><th /><th className="px-2 py-1">Target</th><th className="px-2 py-1">Advised</th><th className="px-2 py-1">Done</th><th className="px-2 py-1">Waiting</th><th className="px-2 py-1">Left to advise</th><th className="w-56 px-2 py-1 text-left">Progress</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const pct = r.target > 0 ? Math.min(100, Math.round((r.executed / r.target) * 100)) : 0;
              const adv = r.target > 0 ? Math.min(100, Math.round((r.advised / r.target) * 100)) : 0;
              return (
                <tr key={r.name} className="border-t border-border text-right num">
                  <td className={cn("py-1.5 text-left font-semibold", r.tone)}>{r.name}</td>
                  <td className="px-2 py-1.5 font-semibold">{formatINRCompact(r.target)}</td>
                  <td className="px-2 py-1.5 text-blue-700">{formatINRCompact(r.advised)}</td>
                  <td className="px-2 py-1.5 text-emerald-700">{formatINRCompact(r.executed)}</td>
                  <td className={cn("px-2 py-1.5", r.pending > 0.5 ? "font-medium text-amber-700" : "text-muted")}>{formatINRCompact(r.pending)}</td>
                  <td className="px-2 py-1.5 font-semibold">{formatINRCompact(r.remaining)}</td>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-2">
                      <div className="relative h-1.5 flex-1 rounded-full bg-slate-100" title={`Advised ${adv}% · done ${pct}%`}>
                        <div className="absolute inset-y-0 left-0 rounded-full bg-blue-200" style={{ width: `${adv}%` }} />
                        <div className="absolute inset-y-0 left-0 rounded-full bg-emerald-500" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="w-9 text-[11px] text-muted">{r.target > 0 ? `${pct}%` : "—"}</span>
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

export default async function Client360(props: PageProps<"/clients/[id]">) {
  const { id } = await props.params;
  const sp = await props.searchParams;
  const raw = String(sp.tab ?? "");
  const tab: Tab = (TABS as readonly string[]).includes(raw) ? (raw as Tab) : LEGACY[raw] ?? "portfolio";
  const str = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : null);
  const { c, bank, unchecked, sip, premium, alerts, casCount, actor } = await pageData(async (tx) => ({
    c: await getClientSummary(tx, id),
    bank: (await tx<{ in_bank: number; fresh_money: number }[]>`
      select in_bank::float8 as in_bank, fresh_money::float8 as fresh_money from public.v_client_bank where client_id = ${id}`)[0] ?? { in_bank: 0, fresh_money: 0 },
    sip: await getClientSip(tx, id),
    premium: await getPremium(tx, id),
    alerts: await getClientAlerts(tx, id),
    // Confirmed CAS from onboarding on: CAS n closes tranche n.
    casCount: Number((await tx<{ n: number; last: string | null }[]>`
      select count(*)::int as n from public.portfolio_snapshots
      where client_id = ${id} and review_status = 'CONFIRMED'
        and snapshot_date >= coalesce((select snapshot_date from public.portfolio_snapshots where client_id = ${id} and is_baseline limit 1), '-infinity'::date)`)[0]?.n ?? 0),
    // A CAS read but not yet checked: its holdings count only once confirmed.
    unchecked: (await tx<{ cas_document_id: string; snapshot_date: string }[]>`
      select s.cas_document_id, s.snapshot_date::text as snapshot_date from public.portfolio_snapshots s
      where s.client_id = ${id} and s.review_status = 'PENDING_REVIEW' and s.cas_document_id is not null
        and s.snapshot_date >= coalesce((select max(snapshot_date) from public.portfolio_snapshots
                                         where client_id = ${id} and review_status = 'CONFIRMED'), '-infinity'::date)
      order by s.snapshot_date desc, s.created_at desc limit 1`)[0] ?? null,
  }));
  const canAdvise = actor.role !== "OPERATIONS";
  const isAdmin = actor.role === "ADMIN";
  // Money from sells not yet bought back sits in the client's bank: it is still theirs.
  const inFunds = c.live_portfolio_value ?? 0;
  const inBank = bank.in_bank;
  const fresh = bank.fresh_money;
  const valueToday = inFunds + inBank;
  const startValue = (c.initial_portfolio_value ?? 0) + fresh;
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
    portfolio: "Portfolio & plan", tranches: `Tranches · ${openTranche}`, sip: "SIP",
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
                  <MenuItem href={tabHref("sip")} hint={`Start / stop / change a SIP · ${formatINRCompact(sip.sip_monthly_yet_to_advise)}/mo left`}><b className="text-violet-700">SIP</b></MenuItem>
                  {c.active_plan_id ? <MenuItem href={`/clients/${id}/plans/${c.active_plan_id}`} hint="Regular → Direct of the same fund, from the plan"><b>Switch call</b></MenuItem> : null}
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
                    <MenuItem href={tabHref("tranches", "#ledger")} hint="When a CAS is wrong or missing: open the call, corrections are on its page">Correct a call / execution</MenuItem>
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

      <Rebalancing c={c} sip={sip} closedBy={casCount > 1 ? `Tranche ${casCount - 1} closed by CAS ${formatDate(c.latest_cas_date)}` : null} />

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
            {t === "tranches" && alerts.unadvised ? <span className="ml-1 rounded-full bg-red-100 px-1.5 text-[10px] text-red-700">{alerts.unadvised.count}</span> : null}
          </Link>
        ))}
      </nav>
      <div className="mt-3">
        {tab === "portfolio" && <PortfolioTab client={c} actor={actor} inBank={inBank} sipTarget={sip.sip_monthly_target} />}
        {tab === "tranches" && <TranchesTab client={c} actor={actor} sipLeft={sip.sip_monthly_yet_to_advise} side={["SELL", "BUY", "PENDING"].includes(str("side") ?? "") ? str("side") : null} />}
        {tab === "sip" && <SipTab client={c} actor={actor} />}
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
