import Link from "next/link";
import { LinkButton } from "@/components/ui/button";
import { Money } from "@/components/app/money";
import { StatusBadge } from "@/components/app/status-badge";
import { TransitionSummary } from "@/components/app/transition-summary";
import { SipSummary } from "@/components/app/sip-summary";
import { getClientSip } from "@/services/sip";
import { getClientAlerts, getPremium } from "@/services/client-record";
import { formatDate, formatINRCompact, humanize, maskPan } from "@/lib/format";
import { pageData } from "@/lib/server";
import { cn } from "@/lib/utils";
import { getClientSummary } from "@/services/clients";
import { PAGES } from "@/lib/brand";
import { OverviewTab } from "./_tabs/overview";
import { PortfolioTab } from "./_tabs/portfolio";
import { PlanTab } from "./_tabs/plan";
import { SipTab } from "./_tabs/sip";
import { CallsTab } from "./_tabs/calls";
import { ExecutionsTab } from "./_tabs/executions";
import { CasTab } from "./_tabs/cas";
import { AgreementsTab } from "./_tabs/agreements";
import { ReportsTab } from "./_tabs/reports";
import { DocumentsTab } from "./_tabs/documents";
import { NotesTab } from "./_tabs/notes";
import { TimelineTab } from "./_tabs/timeline";
import { AuditTab } from "./_tabs/audit";

const TABS = ["overview", "portfolio", "plan", "sip", "calls", "executions", "cas", "agreements", "reports", "documents", "notes", "timeline", "audit"] as const;
type Tab = (typeof TABS)[number];
const LABEL: Record<Tab, string> = {
  overview: "Overview", portfolio: "Portfolio", plan: "Plan", sip: "SIP", calls: "Calls", executions: "Executions",
  cas: "CAS & matching", agreements: "Agreements & premium", reports: "Monthly reports", documents: "Documents",
  notes: "Notes", timeline: "Timeline", audit: "Audit log",
};

export async function generateMetadata(props: PageProps<"/clients/[id]">) {
  const { id } = await props.params;
  return { title: `Client ${id.slice(0, 8)}` };
}

function Fact({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-[10px] font-semibold uppercase tracking-[0.06em] text-muted">{label}</dt>
      <dd className="truncate text-[13px] font-medium">{children}</dd>
    </div>
  );
}

function Alert({ href, tone, children }: { href: string; tone: "red" | "amber" | "blue"; children: React.ReactNode }) {
  const cls = { red: "border-red-200 bg-red-50 text-red-800 hover:bg-red-100", amber: "border-amber-200 bg-amber-50 text-amber-900 hover:bg-amber-100", blue: "border-blue-200 bg-blue-50 text-blue-800 hover:bg-blue-100" }[tone];
  return <Link href={href} className={cn("inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium", cls)}>{children} <span aria-hidden>→</span></Link>;
}

export default async function Client360(props: PageProps<"/clients/[id]">) {
  const { id } = await props.params;
  const sp = await props.searchParams;
  const tab = (TABS as readonly string[]).includes(String(sp.tab)) ? (sp.tab as Tab) : "overview";
  const { c, fresh, unchecked, sip, premium, alerts, actor } = await pageData(async (tx) => ({
    c: await getClientSummary(tx, id),
    fresh: Number((await tx<{ fresh_money: number }[]>`select fresh_money from public.v_client_cash where client_id = ${id}`)[0]?.fresh_money ?? 0),
    sip: await getClientSip(tx, id),
    premium: await getPremium(tx, id),
    alerts: await getClientAlerts(tx, id),
    // A CAS read but not yet checked: its holdings count only once confirmed.
    unchecked: (await tx<{ cas_document_id: string; snapshot_date: string }[]>`
      select s.cas_document_id, s.snapshot_date::text as snapshot_date from public.portfolio_snapshots s
      where s.client_id = ${id} and s.review_status = 'PENDING_REVIEW' and s.cas_document_id is not null
        and s.snapshot_date >= coalesce((select max(snapshot_date) from public.portfolio_snapshots
                                         where client_id = ${id} and review_status = 'CONFIRMED'), '-infinity'::date)
      order by s.snapshot_date desc, s.created_at desc limit 1`)[0] ?? null,
  }));
  const canAdvise = actor.role !== "OPERATIONS";
  const change = (c.live_portfolio_value ?? 0) - (c.initial_portfolio_value ?? 0);
  const thisMonth = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit" }).format(new Date());

  return (
    <>
      <div className="mb-1.5 flex items-center gap-2 text-xs text-muted">
        <Link href="/clients" className="hover:text-ink hover:underline">{PAGES.clients}</Link>
        <span aria-hidden>/</span>
        <span className="num">{c.client_code}</span>
      </div>

      {/* Header: who, what they hold, what they pay */}
      <section className="rounded-xl border border-border bg-surface shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
        <div className="flex flex-col gap-3 p-4 lg:flex-row lg:items-start">
          <div className="min-w-0 flex-1">
            <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
              {c.full_name}
              <span className="rounded-md bg-brand-50 px-2 py-0.5 font-mono text-xs font-semibold text-brand-700 ring-1 ring-brand-100" title="Client ID">{c.client_code}</span>
              <StatusBadge status={c.status} />
            </h1>
            <dl className="mt-2 grid grid-cols-2 gap-x-5 gap-y-1.5 sm:grid-cols-4">
              <Fact label="Advisor">{c.advisor_name ?? "—"}</Fact>
              <Fact label="Risk">{humanize(c.risk_profile)}</Fact>
              <Fact label="Onboarded">{formatDate(c.onboarding_date)}</Fact>
              <Fact label="Latest CAS">{c.latest_cas_date ? formatDate(c.latest_cas_date) : "none"}</Fact>
              <Fact label="PAN">{maskPan(c.pan) ?? "—"}</Fact>
              <Fact label="Phone">{c.phone ?? "—"}</Fact>
              <Fact label="Premium paid">
                <Money value={premium.premium_paid_total} />{" "}
                <span className={premium.premium_status === "ACTIVE" ? (premium.renewal_due ? "text-amber-700" : "text-emerald-700") : "text-red-700"}>
                  · {premium.paid_until ? `till ${formatDate(premium.paid_until)}` : humanize(premium.premium_status)}
                </span>
              </Fact>
              <Fact label="Agreement">
                <span className={premium.agreement_status === "VALID" ? "text-emerald-700" : "text-red-700"}>
                  {premium.agreement_status === "VALID" ? (premium.agreement_valid_to ? `Valid till ${formatDate(premium.agreement_valid_to)}` : "Signed") : premium.agreement_status === "EXPIRED" ? "Expired" : "Not recorded"}
                </span>
              </Fact>
            </dl>
            {c.goal ? <p className="mt-1.5 truncate text-xs text-muted" title={c.goal}>Goal: <span className="text-ink">{c.goal}</span></p> : null}
          </div>
          <div className="flex shrink-0 gap-4 rounded-lg bg-slate-50 px-4 py-2.5 ring-1 ring-border">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-muted">Value today</div>
              <div className="text-xl font-semibold tracking-tight"><Money value={c.live_portfolio_value} /></div>
              <div className="text-[11px] text-muted">{c.live_nav_date ? `NAV ${formatDate(c.live_nav_date)}` : "CAS NAV"}</div>
            </div>
            <div className="border-l border-border pl-4">
              <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-muted">At onboarding</div>
              <div className="text-base font-semibold"><Money value={c.initial_portfolio_value} /></div>
              <div className={cn("text-[11px] font-medium", change >= 0 ? "text-emerald-700" : "text-red-700")}>{change >= 0 ? "+" : "−"}{formatINRCompact(Math.abs(change))}</div>
              {fresh > 0 ? <div className="text-[11px] text-muted">+ fresh <Money value={fresh} /></div> : null}
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap gap-1.5 border-t border-border px-4 py-2">
          {canAdvise ? (
            <>
              <LinkButton href={`/advice/new?client=${id}&side=SELL`} variant="outline" size="sm">Issue sell call</LinkButton>
              <LinkButton href={`/advice/new?client=${id}&side=BUY`} variant="outline" size="sm">Issue buy call</LinkButton>
            </>
          ) : null}
          <LinkButton href={`/executions/pending?client=${id}`} variant="outline" size="sm">Record execution</LinkButton>
          <LinkButton href={`/clients/${id}/cas/upload`} variant="outline" size="sm">Upload CAS</LinkButton>
          <LinkButton href={`/clients/${id}?tab=notes#add-note`} variant="outline" size="sm">Add note</LinkButton>
          <LinkButton href={`/clients/${id}/report?month=${thisMonth}`} variant="outline" size="sm">Monthly report</LinkButton>
          {canAdvise && c.active_plan_id ? <LinkButton href={`/clients/${id}/plans/${c.active_plan_id}`} size="sm">Open portfolio plan</LinkButton> : null}
        </div>
      </section>

      {/* Needs attention */}
      {alerts.unadvised || unchecked || alerts.draftPlan || !c.active_plan_id || alerts.followUpsDue || premium.premium_status !== "ACTIVE" || premium.renewal_due || premium.agreement_status !== "VALID" ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {alerts.unadvised ? (
            <Alert href={`/reconciliation/${alerts.unadvised.runId}`} tone="red">
              Review {alerts.unadvised.count} unadvised trade(s) · {formatINRCompact(alerts.unadvised.amount)}
            </Alert>
          ) : null}
          {unchecked ? <Alert href={`/cas/${unchecked.cas_document_id}`} tone="amber">CAS of {formatDate(unchecked.snapshot_date)} waiting for your check</Alert> : null}
          {alerts.draftPlan ? <Alert href={`/clients/${id}/plans/${alerts.draftPlan.id}`} tone="blue">{alerts.draftPlan.kind === "ADDITIONAL" ? "Additional-investment" : "Draft"} plan to approve: {alerts.draftPlan.name}</Alert> : null}
          {!c.active_plan_id ? <Alert href={canAdvise ? `/clients/${id}/plans/new` : `/clients/${id}?tab=plan`} tone="amber">No active plan</Alert> : null}
          {alerts.followUpsDue ? <Alert href={`/clients/${id}?tab=notes`} tone="amber">{alerts.followUpsDue} follow-up(s) due</Alert> : null}
          {premium.premium_status !== "ACTIVE" ? <Alert href={`/clients/${id}?tab=agreements`} tone="red">Premium {premium.premium_status === "EXPIRED" ? "expired" : premium.premium_status === "PAID" ? "period not recorded" : "not recorded"}</Alert>
            : premium.renewal_due ? <Alert href={`/clients/${id}?tab=agreements`} tone="amber">Premium renewal due {premium.paid_until ? formatDate(premium.paid_until) : ""}</Alert> : null}
          {premium.agreement_status !== "VALID" ? <Alert href={`/clients/${id}?tab=agreements`} tone="red">Advisory agreement {premium.agreement_status === "EXPIRED" ? "expired" : "missing"}</Alert> : null}
        </div>
      ) : null}

      {/* Plan → Advice → Execution, lump sum and SIP side by side */}
      <div className="mt-3 grid items-start gap-3 xl:grid-cols-3">
        <TransitionSummary compact side="SELL" n={{ target: c.target_sell, advised: c.advised_sell, executed: c.executed_sell, pending: c.pending_sell, yetToAdvise: c.yet_to_advise_sell }} />
        <TransitionSummary compact side="BUY" n={{ target: c.target_buy, advised: c.advised_buy, executed: c.executed_buy, pending: c.pending_buy, yetToAdvise: c.yet_to_advise_buy }} />
        <SipSummary s={sip} compact planHref={c.active_plan_id ? `/clients/${id}?tab=sip` : null} />
      </div>
      {c.off_plan_pending > 0 ? <p className="mt-1.5 text-xs text-muted">Also <Money value={c.off_plan_pending} /> pending on off-plan calls (not linked to a plan item).</p> : null}

      {/* Tabs */}
      <nav className="sticky top-0 z-20 mt-4 flex gap-0.5 overflow-x-auto border-b border-border bg-background/95 backdrop-blur">
        {TABS.map((t) => (
          <Link
            key={t}
            href={`/clients/${id}?tab=${t}`}
            className={cn(
              "-mb-px whitespace-nowrap border-b-2 px-2.5 py-2 text-[13px] transition-colors",
              t === tab ? "border-brand font-semibold text-brand" : "border-transparent text-muted hover:border-border hover:text-ink",
            )}
          >
            {LABEL[t]}
            {t === "calls" && alerts.openCalls ? <span className="ml-1 rounded-full bg-blue-100 px-1.5 text-[10px] text-blue-700">{alerts.openCalls}</span> : null}
            {t === "cas" && alerts.unadvised ? <span className="ml-1 rounded-full bg-red-100 px-1.5 text-[10px] text-red-700">{alerts.unadvised.count}</span> : null}
          </Link>
        ))}
      </nav>
      <div className="mt-3">
        {tab === "overview" && <OverviewTab client={c} actor={actor} />}
        {tab === "portfolio" && <PortfolioTab clientId={id} actor={actor} />}
        {tab === "plan" && <PlanTab clientId={id} actor={actor} />}
        {tab === "sip" && <SipTab client={c} actor={actor} />}
        {tab === "calls" && <CallsTab clientId={id} actor={actor} />}
        {tab === "executions" && <ExecutionsTab clientId={id} actor={actor} />}
        {tab === "cas" && <CasTab clientId={id} actor={actor} />}
        {tab === "agreements" && <AgreementsTab clientId={id} actor={actor} />}
        {tab === "reports" && <ReportsTab client={c} />}
        {tab === "documents" && <DocumentsTab clientId={id} actor={actor} />}
        {tab === "notes" && <NotesTab clientId={id} actor={actor} />}
        {tab === "timeline" && <TimelineTab clientId={id} actor={actor} kind={typeof sp.kind === "string" ? sp.kind : null} />}
        {tab === "audit" && <AuditTab clientId={id} actor={actor} />}
      </div>
    </>
  );
}
