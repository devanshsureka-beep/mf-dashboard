import Link from "next/link";
import { LinkButton } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Money } from "@/components/app/money";
import { StatusBadge } from "@/components/app/status-badge";
import { TransitionSummary } from "@/components/app/transition-summary";
import { formatDate, humanize } from "@/lib/format";
import { pageData } from "@/lib/server";
import { cn } from "@/lib/utils";
import { getClientSummary } from "@/services/clients";
import { PAGES } from "@/lib/brand";
import { OverviewTab } from "./_tabs/overview";
import { PortfolioTab } from "./_tabs/portfolio";
import { PlanTab } from "./_tabs/plan";
import { CallsTab } from "./_tabs/calls";
import { ExecutionsTab } from "./_tabs/executions";
import { CasTab } from "./_tabs/cas";
import { DocumentsTab } from "./_tabs/documents";
import { NotesTab } from "./_tabs/notes";
import { AuditTab } from "./_tabs/audit";

const TABS = ["overview", "portfolio", "plan", "calls", "executions", "cas", "documents", "notes", "audit"] as const;
type Tab = (typeof TABS)[number];
const LABEL: Record<Tab, string> = {
  overview: "Overview", portfolio: "Portfolio", plan: "Plan", calls: "Calls", executions: "Executions",
  cas: "CAS", documents: "Documents", notes: "Notes", audit: "Audit log",
};

export async function generateMetadata(props: PageProps<"/clients/[id]">) {
  const { id } = await props.params;
  return { title: `Client ${id.slice(0, 8)}` };
}

export default async function Client360(props: PageProps<"/clients/[id]">) {
  const { id } = await props.params;
  const sp = await props.searchParams;
  const tab = (TABS as readonly string[]).includes(String(sp.tab)) ? (sp.tab as Tab) : "overview";
  const { c, actor } = await pageData(async (tx) => ({ c: await getClientSummary(tx, id) }));
  const canAdvise = actor.role !== "OPERATIONS";

  return (
    <>
      {/* Header */}
      <div className="mb-2 flex items-center gap-2 text-xs text-muted">
        <Link href="/clients" className="hover:text-ink hover:underline">{PAGES.clients}</Link>
        <span aria-hidden>/</span>
        <span className="num">{c.client_code}</span>
      </div>
      <section className="mb-4 overflow-hidden rounded-xl border border-border bg-surface shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
        <div className="flex flex-col gap-5 p-5 md:flex-row md:items-start md:justify-between">
          <div className="flex min-w-0 flex-1 items-start gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand-50 text-base font-semibold text-brand-700 ring-1 ring-brand-100" aria-hidden>
              {c.full_name.split(/\s+/).map((w: string) => w[0]).slice(0, 2).join("").toUpperCase()}
            </div>
            <div className="min-w-0">
              <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight">
                {c.full_name}
                <StatusBadge status={c.status} />
                {c.unadvised_count > 0 ? <Badge tone="danger">{c.unadvised_count} unadvised change(s)</Badge> : null}
              </h1>
              <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm">
                <div className="flex gap-1.5"><dt className="text-muted">Client ID</dt><dd className="num font-medium">{c.client_code}</dd></div>
                <div className="flex gap-1.5"><dt className="text-muted">Advisor</dt><dd className="font-medium">{c.advisor_name ?? "—"}</dd></div>
                <div className="flex gap-1.5"><dt className="text-muted">Risk</dt><dd className="font-medium">{humanize(c.risk_profile)}</dd></div>
                <div className="flex gap-1.5"><dt className="text-muted">Latest CAS</dt><dd className="font-medium">{c.latest_cas_date ? formatDate(c.latest_cas_date) : "none"}</dd></div>
                {c.next_review_date ? <div className="flex gap-1.5"><dt className="text-muted">Next review</dt><dd className="font-medium">{formatDate(c.next_review_date)}</dd></div> : null}
              </dl>
              {c.goal ? <p className="mt-1.5 max-w-3xl text-sm text-muted">Goal: <span className="text-ink">{c.goal}</span></p> : null}
            </div>
          </div>
          <div className="shrink-0 rounded-lg bg-slate-50 px-4 py-3 ring-1 ring-border md:text-right">
            <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">Portfolio value</div>
            <div className="text-2xl font-semibold tracking-tight"><Money value={c.current_portfolio_value} /></div>
            <div className="text-xs text-muted">
              At onboarding <Money value={c.initial_portfolio_value} />{c.baseline_date ? ` (${formatDate(c.baseline_date)})` : ""}
            </div>
          </div>
        </div>
      </section>

      {/* Primary summary */}
      <div className="grid gap-3 lg:grid-cols-2">
        <TransitionSummary side="SELL" n={{ target: c.target_sell, advised: c.advised_sell, executed: c.executed_sell, pending: c.pending_sell, yetToAdvise: c.yet_to_advise_sell }} />
        <TransitionSummary side="BUY" n={{ target: c.target_buy, advised: c.advised_buy, executed: c.executed_buy, pending: c.pending_buy, yetToAdvise: c.yet_to_advise_buy }} />
      </div>
      {!c.active_plan_id ? (
        <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">No active advisory plan. Targets stay at zero until a plan is approved. {canAdvise ? <Link className="underline" href={`/clients/${id}/plans/new`}>Create a plan</Link> : null}</p>
      ) : null}
      {c.off_plan_pending > 0 ? <p className="mt-2 text-xs text-muted">Also <Money value={c.off_plan_pending} /> pending on off-plan calls (not linked to a plan item).</p> : null}

      {/* Quick actions */}
      <div className="mt-4 flex flex-wrap gap-2">
        {canAdvise ? (
          <>
            <LinkButton href={`/advice/new?client=${id}&side=SELL`} variant="outline" size="sm">Issue sell call</LinkButton>
            <LinkButton href={`/advice/new?client=${id}&side=BUY`} variant="outline" size="sm">Issue buy call</LinkButton>
          </>
        ) : null}
        <LinkButton href={`/executions/pending?client=${id}`} variant="outline" size="sm">Record execution</LinkButton>
        <LinkButton href={`/clients/${id}/cas/upload`} variant="outline" size="sm">Upload CAS</LinkButton>
        <LinkButton href={`/clients/${id}?tab=notes#add-note`} variant="outline" size="sm">Add note</LinkButton>
        {canAdvise && c.active_plan_id ? <LinkButton href={`/clients/${id}/plans/${c.active_plan_id}`} size="sm">Open portfolio plan</LinkButton> : null}
      </div>

      {/* Tabs */}
      <nav className="mt-6 flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map((t) => (
          <Link
            key={t}
            href={`/clients/${id}?tab=${t}`}
            className={cn(
              "-mb-px whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm transition-colors",
              t === tab ? "border-brand font-semibold text-brand" : "border-transparent text-muted hover:border-border hover:text-ink",
            )}
          >
            {LABEL[t]}
          </Link>
        ))}
      </nav>
      <div className="mt-4">
        {tab === "overview" && <OverviewTab client={c} actor={actor} />}
        {tab === "portfolio" && <PortfolioTab clientId={id} actor={actor} />}
        {tab === "plan" && <PlanTab clientId={id} actor={actor} />}
        {tab === "calls" && <CallsTab clientId={id} actor={actor} />}
        {tab === "executions" && <ExecutionsTab clientId={id} actor={actor} />}
        {tab === "cas" && <CasTab clientId={id} actor={actor} />}
        {tab === "documents" && <DocumentsTab clientId={id} actor={actor} />}
        {tab === "notes" && <NotesTab clientId={id} actor={actor} />}
        {tab === "audit" && <AuditTab clientId={id} actor={actor} />}
      </div>
    </>
  );
}
