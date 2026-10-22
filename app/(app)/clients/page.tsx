import { HubTabs } from "@/components/app/hub-tabs";
import { maskPan } from "@/lib/domain/cas-review";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/form";
import { AutoSelect } from "@/components/app/auto-select";
import { Button, LinkButton } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/app/page-header";
import { formatDate, formatINRCompact, humanize } from "@/lib/format";
import { pageData } from "@/lib/server";
import { cn } from "@/lib/utils";
import { listAdvisors, listDeskClients, type DeskFilters } from "@/services/clients";
import { listDeletedClients } from "@/services/client-admin";
import { listDraftPlans } from "@/services/plans";
import { DraftList } from "@/components/app/draft-list";
import { CLIENT_STATUSES, RISK_PROFILES } from "@/types/domain";
import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { SelectAll } from "@/components/app/select-all";
import { deleteClientsAction, reassignClientsAction, restoreClientsAction } from "./actions";
import { ClientList, type ListRow, type ListTag } from "./client-list";
import { LiveSearch } from "./live-search";
import { Suspense } from "react";

export const metadata = { title: "Premium clients" };

const lakh = (v: string | undefined) => (v && Number(v) > 0 ? Number(v) * 100000 : null);

type Desk = Awaited<ReturnType<typeof listDeskClients>>[number];
const VIEWS: { key: string; label: string; params: Record<string, string | undefined>; match: (f: DeskFilters) => boolean; count: (c: Desk) => boolean; alert?: boolean }[] = [
  { key: "all", label: "All", params: {}, match: (f) => !f.attention && !f.plan && !f.premium && !f.agreement, count: () => true },
  { key: "draft", label: "Drafts", params: { plan: "draft" }, match: (f) => f.plan === "draft", count: (c) => c.has_draft_plan },
  { key: "needs", label: "Needs action", params: { attention: "needs" }, match: (f) => f.attention === "needs", count: (c) => c.action_count > 0, alert: true },
  { key: "tranche", label: "Next tranche to advise", params: { attention: "tranche" }, match: (f) => f.attention === "tranche", count: (c) => Boolean(c.active_plan_id) && c.pending_total < 0.5 && c.remaining_to_advise >= 0.5 },
  { key: "pending", label: "Waiting for client", params: { attention: "pending" }, match: (f) => f.attention === "pending", count: (c) => c.pending_total > 0 },
  { key: "unadvised", label: "Unadvised Trades", params: { attention: "unadvised" }, match: (f) => f.attention === "unadvised", count: (c) => c.unadvised_to_review > 0, alert: true },
  { key: "cas", label: "CAS to check", params: { attention: "cas_review" }, match: (f) => f.attention === "cas_review", count: (c) => c.cas_to_review > 0 },
  { key: "follow", label: "Follow-ups due", params: { attention: "follow_up" }, match: (f) => f.attention === "follow_up", count: (c) => c.follow_ups_due > 0 },
  { key: "agreement", label: "No agreement", params: { agreement: "missing" }, match: (f) => f.agreement === "missing", count: (c) => c.agreement_status !== "VALID" },
];

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** The months clients were onboarded in, newest first, with how many. */
function months(rows: Desk[]): { key: string; label: string; n: number }[] {
  const by = new Map<string, number>();
  for (const c of rows) { const k = String(c.report_date).slice(0, 7); by.set(k, (by.get(k) ?? 0) + 1); }
  return [...by.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([k, n]) => ({ key: k, label: `${MON[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}`, n }));
}

const sumOf = (rows: Desk[], f: (c: Desk) => number) => rows.reduce((t, c) => t + f(c), 0);
const nextTrancheOf = (c: Desk) => Boolean(c.active_plan_id) && c.pending_total < 0.5 && c.remaining_to_advise >= 0.5;
/** The six stage tiles, each a saved view with its money and what is getting old. */
const STAGES: { view: string; label: string; line: (rows: Desk[]) => string; sub: (rows: Desk[]) => string; warn?: (rows: Desk[]) => boolean }[] = [
  { view: "all", label: "All clients", line: (r) => `${formatINRCompact(sumOf(r, (c) => Math.max(0, (c.live_portfolio_value ?? 0) + c.funds_adjust)))} in funds`, sub: (r) => `${r.filter((c) => c.active_plan_id).length} on a live plan` },
  { view: "draft", label: "Drafts to approve", line: () => "review & approve", sub: (r) => { const d = Math.max(-1, ...r.filter((c) => c.has_draft_plan).map((c) => c.draft_days ?? 0)); return d >= 0 ? `oldest ${d} day${d === 1 ? "" : "s"}` : "none waiting"; }, warn: (r) => r.some((c) => c.has_draft_plan && (c.draft_days ?? 0) > 7) },
  { view: "tranche", label: "Next tranche to advise", line: (r) => `${formatINRCompact(sumOf(r.filter(nextTrancheOf), (c) => c.remaining_to_advise))} left to advise`, sub: (r) => `${r.filter((c) => nextTrancheOf(c) && (c.last_call_days == null || c.last_call_days > 14)).length} quiet over 14 days`, warn: (r) => r.some((c) => nextTrancheOf(c) && (c.last_call_days == null || c.last_call_days > 14)) },
  { view: "pending", label: "Waiting on client", line: (r) => `${formatINRCompact(sumOf(r, (c) => c.pending_total))} not done yet`, sub: (r) => (r.some((c) => c.pending_total >= 0.5) ? "check with the client" : "all clear") },
  { view: "cas", label: "CAS to check", line: () => "in the CAS inbox", sub: (r) => `${r.filter((c) => c.cas_to_review > 0 && c.unadvised_to_review > 0).length} also with trades to decide` },
  { view: "agreement", label: "Admin to fix", line: () => "no agreement on file", sub: (r) => `${r.filter((c) => c.agreement_status !== "VALID" && c.premium_status === "UNPAID").length} also premium not recorded` },
];

/** A URL value from a fixed list, else undefined (an unknown filter must not change what is shown). */
function pick<T extends string>(v: string | undefined, allowed: readonly T[]): T | undefined {
  return allowed.includes(v as T) ? (v as T) : undefined;
}

export default async function ClientsPage(props: PageProps<"/clients">) {
  const sp = await props.searchParams;
  const one = (k: string) => (typeof sp[k] === "string" && sp[k] ? (sp[k] as string) : undefined);
  const f: DeskFilters = {
    q: one("q"), advisorId: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(one("advisor") ?? "") ? one("advisor") : undefined,
    status: (CLIENT_STATUSES as readonly string[]).includes(one("status") ?? "") ? one("status") : undefined,
    risk: (RISK_PROFILES as readonly string[]).includes(one("risk") ?? "") ? one("risk") : undefined,
    plan: pick(one("plan"), ["active", "draft", "none"] as const), premium: pick(one("premium"), ["active", "renewal_due", "expired", "unpaid"] as const),
    agreement: pick(one("agreement"), ["valid", "missing"] as const),
    attention: pick(one("attention"), ["pending", "unadvised", "cas_review", "follow_up", "no_plan", "tranche", "needs"] as const),
    minValue: lakh(one("min")), maxValue: lakh(one("max")),
    month: /^\d{4}-(0[1-9]|1[0-2])$/.test(one("month") ?? "") ? one("month") : null, sort: pick(one("sort"), ["name", "value", "pending", "onboarded", "renewal", "code", "action", "left"] as const) ?? "action",
  };
  const showDeleted = one("deleted") === "1";
  const draftView = f.plan === "draft";
  // The tiles count within the search, advisor, risk and month picked; only the view itself is left out.
  const base: DeskFilters = { ...f, attention: undefined, plan: undefined, premium: undefined, agreement: undefined };
  const { clients, all, everyone, advisors, deleted, drafts, actor } = await pageData(async (tx, a) => {
    const canAdvise = a.role !== "OPERATIONS";
    const clients = await listDeskClients(tx, { ...f, canAdvise });
    // The Drafts view lists the drafts of exactly the clients its tile counts (same search and filters).
    const ids = new Set(clients.map((c) => c.client_id));
    return {
      clients,
      drafts: draftView ? (await listDraftPlans(tx, { advisorId: f.advisorId })).filter((d) => ids.has(d.client_id)) : [],
      all: await listDeskClients(tx, { ...base, canAdvise }),
      everyone: f.month ? await listDeskClients(tx, { ...base, month: null, canAdvise }) : null,
      advisors: await listAdvisors(tx),
      deleted: a.role === "ADMIN" ? await listDeletedClients(tx) : [],
    };
  });
  const isAdmin = actor.role === "ADMIN";
  if (isAdmin && showDeleted) return <DeletedClients rows={deleted} />;

  const count = (pred: (c: (typeof all)[number]) => boolean) => all.filter(pred).length;
  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...Object.fromEntries(Object.entries(sp).filter(([, v]) => typeof v === "string")), ...patch })) if (v) p.set(k, v as string);
    const s = p.toString();
    return `/clients${s ? `?${s}` : ""}`;
  };
  const activeFilters = Object.entries(sp).filter(([k, v]) => typeof v === "string" && v && k !== "sort").length;
  // A view keeps the search and the other filters, and replaces only what it is about.
  const viewHref = (params: Record<string, string | undefined>) => qs({ attention: undefined, plan: undefined, premium: undefined, agreement: undefined, ...params });

  return (
    <>
      <PageHeader
        title="Clients"
        actions={
          <div className="flex items-center gap-2">
            {isAdmin && deleted.length ? <Link href="/clients?deleted=1" className="text-xs text-muted hover:underline">Deleted clients · {deleted.length}</Link> : null}
            {actor.role !== "OPERATIONS" ? <LinkButton href="/onboard">Onboard client</LinkButton> : null}
          </div>
        }
      />

      {/* The book by stage: every stage visible at once, click one to list its clients. */}
      <div className="mb-2 flex flex-wrap items-center gap-x-2 text-[11px] uppercase tracking-[0.05em] text-muted">
        <span>Every client moves through:</span><span className="text-ink">Draft plan</span>→<span className="text-ink">Advise tranche</span>→<span className="text-ink">Client acts</span>→<span className="text-ink">CAS confirms</span>→<span className="text-ink">next tranche</span>
      </div>
      <nav aria-label="Stages" className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        {STAGES.map((t) => {
          const v = VIEWS.find((x) => x.key === t.view)!;
          const on = v.match(f);
          const n = count(v.count);
          return (
            <Link key={t.view} href={viewHref(v.params)} aria-current={on ? "page" : undefined}
              className={cn("rounded-xl border p-3 transition-colors", on ? "border-2 border-brand bg-brand-50 p-[11px]" : "border-border bg-surface hover:border-brand-200")}>
              <div className={cn("text-xs font-semibold", on ? "text-brand-700" : "text-slate-600")}>{t.label}</div>
              <div className={cn("text-2xl font-bold tracking-tight num", n === 0 ? "text-slate-300" : on ? "text-brand-800" : "text-ink")}>{n}</div>
              <div className="truncate text-xs text-slate-700">{t.line(all)}</div>
              <div className={cn("truncate text-[11px]", t.warn?.(all) ? "text-amber-700" : "text-muted")}>{t.sub(all)}</div>
            </Link>
          );
        })}
      </nav>
      <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs">
        <span className="text-muted">Also:</span>
        {(["needs", "unadvised", "follow"] as const).map((k) => {
          const v = VIEWS.find((x) => x.key === k)!;
          const n = count(v.count);
          return (
            <Link key={k} href={viewHref(v.params)} aria-current={v.match(f) ? "page" : undefined}
              className={cn("rounded-full px-2.5 py-1 ring-1", v.match(f) ? "bg-brand-50 font-semibold text-brand-700 ring-brand" : n ? "bg-white text-slate-700 ring-border hover:ring-brand-200" : "bg-white text-slate-400 ring-border")}>
              {v.label} <b className={cn(n && v.alert ? "text-red-700" : "")}>{n}</b>
            </Link>
          );
        })}
        <Link className={cn("rounded-full bg-white px-2.5 py-1 ring-1 ring-border hover:ring-brand-200", f.premium === "renewal_due" && "bg-brand-50 font-semibold text-brand-700 ring-brand")} href={viewHref({ premium: "renewal_due" })}>Renewal due</Link>
        <Link className={cn("rounded-full bg-white px-2.5 py-1 ring-1 ring-border hover:ring-brand-200", f.premium === "expired" && "bg-brand-50 font-semibold text-brand-700 ring-brand")} href={viewHref({ premium: "expired" })}>Premium expired</Link>
        <Link className={cn("rounded-full bg-white px-2.5 py-1 ring-1 ring-border hover:ring-brand-200", f.attention === "no_plan" && "bg-brand-50 font-semibold text-brand-700 ring-brand")} href={viewHref({ attention: "no_plan" })}>No active plan</Link>
      </div>

      <form className="mb-3 flex flex-wrap items-center gap-2" method="get">
        <Suspense fallback={<Input name="q" defaultValue={f.q} className="h-9 w-72" aria-label="Search" />}><LiveSearch defaultValue={f.q} /></Suspense>
        {actor.role !== "ADVISOR" ? (
          <AutoSelect name="advisor" defaultValue={f.advisorId ?? ""} className="h-9 w-44" aria-label="Advisor">
            <option value="">All advisors</option>
            {advisors.map((a) => <option key={a.id} value={a.id}>{a.full_name}</option>)}
          </AutoSelect>
        ) : null}
        <AutoSelect name="risk" defaultValue={f.risk ?? ""} className="h-9 w-40" aria-label="Risk">
          <option value="">Any risk</option>
          {RISK_PROFILES.map((r) => <option key={r} value={r}>{humanize(r)}</option>)}
        </AutoSelect>
        <AutoSelect name="month" defaultValue={f.month ?? ""} className="h-9 w-44" aria-label="Report month">
          <option value="">Report month: any</option>
          {months(everyone ?? all).map((m) => <option key={m.key} value={m.key}>{m.label} · {m.n}</option>)}
        </AutoSelect>
        <AutoSelect name="sort" defaultValue={f.sort} className="h-9 w-48" aria-label="Sort">
          <option value="action">Needs action first</option><option value="left">Most left to advise</option><option value="value">Value (high first)</option>
          <option value="pending">Waiting (high first)</option><option value="name">Name</option><option value="onboarded">Newest report first</option>
        </AutoSelect>
        {(["status", "plan", "premium", "attention", "agreement", "min", "max"] as const).map((k) => one(k) ? <input key={k} type="hidden" name={k} value={one(k)} /> : null)}
        <noscript><Button type="submit" variant="outline" size="sm">Apply</Button></noscript>
        {activeFilters ? <Link href="/clients" className="text-xs text-muted hover:underline">Clear filters</Link> : null}
        <span className="ml-auto text-[11px] text-muted">To-dos under each name are in the order to do them; the first is a button · tick clients for one action on all · click a column to sort</span>
      </form>

      {draftView ? (
        <>
          <p className="mb-2 text-xs text-muted">Each draft opens its plan: answer its questions, check the lines, approve. Nothing counts until it is approved.</p>
          <DraftList rows={drafts} />
        </>
      ) : <ClientList
        rows={clients.map((c) => toRow(c, actor.role !== "OPERATIONS"))}
        isAdmin={isAdmin}
        canAdvise={actor.role !== "OPERATIONS"}
        advisors={advisors.map((a) => ({ id: a.id, name: a.full_name }))}
        deleteAction={deleteClientsAction}
        reassignAction={reassignClientsAction}
      />}
    </>
  );
}

type Row = Awaited<ReturnType<typeof listDeskClients>>[number];

/** One client as the list shows it (plain data for the client-side table). */
function toRow(c: Row, canAdvise: boolean): ListRow {
  const target = c.target_sell + c.target_buy;
  const inBank = c.in_bank;
  // In funds now: live value moved by trades approved since the last CAS (same rule as the client page).
  const inFunds = c.live_portfolio_value == null ? null : Math.max(0, c.live_portfolio_value + c.funds_adjust);
  const nextTranche = Boolean(c.active_plan_id) && c.pending_total < 0.5 && c.remaining_to_advise >= 0.5;
  const tranchesHref = `/clients/${c.client_id}?tab=tranches`;
  const tag: ListTag | null = c.status !== "ACTIVE" ? { text: humanize(c.status), tone: c.status === "ONBOARDING" ? "blue" : "grey" } : null;
  // In the order to do them: the CAS first (it decides what is left), then trades, waiting, the plan, the rest.
  const todos: ListTag[] = [];
  if (c.cas_to_review) todos.push({ text: "Check CAS", tone: "amber", href: `/reconciliation?c=${c.client_id}` });
  if (c.unadvised_to_review) todos.push({ text: `${c.unadvised_to_review} trade${c.unadvised_to_review === 1 ? "" : "s"} to decide`, tone: "amber", href: `/reconciliation?c=${c.client_id}` });
  if (c.pending_total >= 0.5) todos.push({ text: `${formatINRCompact(c.pending_total)} waiting`, tone: "amber", href: `${tranchesHref}&side=PENDING#ledger` });
  if (canAdvise && c.has_draft_plan) todos.push({ text: "Approve draft", tone: "brand", href: c.draft_plan_id ? `/clients/${c.client_id}/plans/${c.draft_plan_id}` : "/clients?plan=draft" });
  if (canAdvise && nextTranche) todos.push({ text: `Advise tranche · ${formatINRCompact(c.remaining_to_advise)}`, tone: "brand", href: tranchesHref });
  if (c.follow_ups_due) todos.push({ text: `${c.follow_ups_due} follow-up${c.follow_ups_due === 1 ? "" : "s"} due`, tone: "grey", href: `/clients/${c.client_id}?tab=file#notes` });
  if (c.agreement_status !== "VALID") todos.push({ text: c.agreement_status === "EXPIRED" ? "Renew agreement" : "Upload agreement", tone: "grey", href: `/clients/${c.client_id}?tab=file` });
  return {
    id: c.client_id, name: c.full_name, code: c.client_code, tag, todos, casToCheck: c.cas_to_review > 0, openCalls: c.open_calls,
    month: MON[Number(c.report_date.slice(5, 7)) - 1] ?? "", reportDate: c.report_date, pendingCas: c.pending_cas_date,
    advisor: c.advisor_name ?? "—", risk: c.risk_profile ? humanize(c.risk_profile) : "—",
    valueToday: inFunds == null && inBank < 0.5 ? null : (inFunds ?? 0) + inBank,
    inFunds, inBank,
    tranche: c.active_plan_id ? (target > 0 ? `Tranche ${Math.max(1, c.cas_count)}` : "No targets") : null,
    donePct: target > 0 ? Math.round(((c.executed_sell + c.executed_buy) / target) * 100) : null,
    advisedPct: target > 0 ? Math.round(((c.advised_sell + c.advised_buy) / target) * 100) : 0,
    left: c.remaining_to_advise, waiting: c.pending_total, sip: c.sip_monthly_target,
    premium: c.premium_paid_total,
    premiumNote: c.paid_until ? `${c.premium_status === "EXPIRED" ? "Expired" : "Paid till"} ${formatDate(c.paid_until)}` : c.premium_status === "UNPAID" ? "Not recorded" : "No period",
    premiumTone: c.premium_status === "ACTIVE" ? (c.renewal_due ? "amber" : "green") : "red",
    agreementGap: c.agreement_status !== "VALID" ? `no agreement${c.agreement_status === "EXPIRED" ? " (expired)" : ""}` : null,
    latestCas: c.real_cas_date, since: c.onboarding_date,
  };
}

function DeletedClients({ rows }: { rows: Awaited<ReturnType<typeof listDeletedClients>> }) {
  return (
    <>
      <PageHeader title="Team & access" subtitle="Deleted clients are hidden from every screen. Their full history is kept; restore brings everything back." actions={<LinkButton href="/clients" variant="outline">Back to clients</LinkButton>} />
      <HubTabs hub="admin" active="deleted" role="ADMIN" />
      {rows.length === 0 ? <Card><div className="p-4"><EmptyState title="No deleted clients" /></div></Card> : (
        <ActionForm action={restoreClientsAction}>
          <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-white p-2 text-xs">
            <Input name="reason" required placeholder="Reason for restoring" className="h-8 w-64" aria-label="Reason for restoring" />
            <SubmitButton size="sm">Restore selected</SubmitButton>
          </div>
          <Card>
            <table className="w-full text-[13px]">
              <thead className="border-b border-border bg-slate-50 text-left text-[10.5px] font-semibold uppercase tracking-wide text-muted">
                <tr><th className="w-8 py-2 pl-3"><SelectAll label="" /></th><th className="px-3 py-2">Client</th><th className="px-2 py-2">PAN</th><th className="px-2 py-2">Deleted</th><th className="px-2 py-2">By</th><th className="px-2 py-2">Reason</th></tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="py-2 pl-3"><input type="checkbox" name="ids" value={r.id} aria-label={`Select ${r.full_name}`} /></td>
                    <td className="px-3 py-2 font-medium">{r.full_name}<div className="font-mono text-[11px] text-muted">{r.client_code}</div></td>
                    <td className="px-2 py-2 font-mono text-xs">{r.pan ? maskPan(r.pan) : "—"}</td>
                    <td className="whitespace-nowrap px-2 py-2 text-xs">{formatDate(r.deleted_at)}</td>
                    <td className="px-2 py-2 text-xs">{r.deleted_by_name ?? "—"}</td>
                    <td className="px-2 py-2 text-xs">{r.deleted_reason ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </ActionForm>
      )}
    </>
  );
}
