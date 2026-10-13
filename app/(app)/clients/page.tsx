import { HubTabs } from "@/components/app/hub-tabs";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/form";
import { Button, LinkButton } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/app/page-header";
import { formatDate, formatINRCompact, humanize } from "@/lib/format";
import { pageData } from "@/lib/server";
import { cn } from "@/lib/utils";
import { listAdvisors, listDeskClients, type DeskFilters } from "@/services/clients";
import { listDeletedClients } from "@/services/client-admin";
import { CLIENT_STATUSES, RISK_PROFILES } from "@/types/domain";
import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { SelectAll } from "@/components/app/select-all";
import { deleteClientsAction, reassignClientsAction, restoreClientsAction } from "./actions";
import { ClientList, type ListRow, type ListTag } from "./client-list";

export const metadata = { title: "Premium clients" };

const lakh = (v: string | undefined) => (v && Number(v) > 0 ? Number(v) * 100000 : null);

type Desk = Awaited<ReturnType<typeof listDeskClients>>[number];
const VIEWS: { key: string; label: string; params: Record<string, string | undefined>; match: (f: DeskFilters) => boolean; count: (c: Desk) => boolean; alert?: boolean }[] = [
  { key: "all", label: "All", params: {}, match: (f) => !f.attention && !f.plan && !f.premium && !f.agreement, count: () => true },
  { key: "needs", label: "Needs action", params: { attention: "needs" }, match: (f) => f.attention === "needs", count: (c) => c.action_count > 0, alert: true },
  { key: "tranche", label: "Next tranche to advise", params: { attention: "tranche" }, match: (f) => f.attention === "tranche", count: (c) => Boolean(c.active_plan_id) && c.pending_total < 0.5 && c.remaining_to_advise >= 0.5 },
  { key: "pending", label: "Waiting for client", params: { attention: "pending" }, match: (f) => f.attention === "pending", count: (c) => c.pending_total > 0 },
  { key: "unadvised", label: "Unadvised Trades", params: { attention: "unadvised" }, match: (f) => f.attention === "unadvised", count: (c) => c.unadvised_to_review > 0, alert: true },
  { key: "cas", label: "CAS to check", params: { attention: "cas_review" }, match: (f) => f.attention === "cas_review", count: (c) => c.cas_to_review > 0 },
  { key: "draft", label: "Plan to approve", params: { plan: "draft" }, match: (f) => f.plan === "draft", count: (c) => c.has_draft_plan },
  { key: "follow", label: "Follow-ups due", params: { attention: "follow_up" }, match: (f) => f.attention === "follow_up", count: (c) => c.follow_ups_due > 0 },
  { key: "agreement", label: "No agreement", params: { agreement: "missing" }, match: (f) => f.agreement === "missing", count: (c) => c.agreement_status !== "VALID" },
];

export default async function ClientsPage(props: PageProps<"/clients">) {
  const sp = await props.searchParams;
  const one = (k: string) => (typeof sp[k] === "string" && sp[k] ? (sp[k] as string) : undefined);
  const f: DeskFilters = {
    q: one("q"), advisorId: /^[0-9a-f-]{36}$/i.test(one("advisor") ?? "") ? one("advisor") : undefined,
    status: (CLIENT_STATUSES as readonly string[]).includes(one("status") ?? "") ? one("status") : undefined,
    risk: (RISK_PROFILES as readonly string[]).includes(one("risk") ?? "") ? one("risk") : undefined,
    plan: one("plan") as DeskFilters["plan"], premium: one("premium") as DeskFilters["premium"],
    agreement: one("agreement") as DeskFilters["agreement"], attention: one("attention") as DeskFilters["attention"],
    minValue: lakh(one("min")), maxValue: lakh(one("max")), sort: (one("sort") as DeskFilters["sort"]) ?? "action",
  };
  const showDeleted = one("deleted") === "1";
  const { clients, all, advisors, deleted, actor } = await pageData(async (tx, a) => ({
    clients: await listDeskClients(tx, f),
    all: await listDeskClients(tx, {}),
    advisors: await listAdvisors(tx),
    deleted: a.role === "ADMIN" ? await listDeletedClients(tx) : [],
  }));
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

      {/* Saved views */}
      <nav aria-label="Views" className="mb-3 flex gap-0.5 overflow-x-auto border-b border-border">
        {VIEWS.map((v) => {
          const on = v.match(f);
          return (
            <Link key={v.key} href={viewHref(v.params)} aria-current={on ? "page" : undefined}
              className={cn("-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-[13.5px]", on ? "border-brand font-semibold text-brand" : "border-transparent text-slate-600 hover:text-ink")}>
              {v.label} <span className={cn("ml-0.5 text-xs", v.alert && count(v.count) ? "font-semibold text-red-700" : "text-muted")}>{count(v.count)}</span>
            </Link>
          );
        })}
      </nav>

      <form className="mb-3 flex flex-wrap items-center gap-2" method="get">
        <Input name="q" placeholder="Name, client ID, phone, email…" defaultValue={f.q} className="h-9 w-72" aria-label="Search" />
        {actor.role !== "ADVISOR" ? (
          <Select name="advisor" defaultValue={f.advisorId ?? ""} className="h-9 w-44" aria-label="Advisor">
            <option value="">All advisors</option>
            {advisors.map((a) => <option key={a.id} value={a.id}>{a.full_name}</option>)}
          </Select>
        ) : null}
        <Select name="sort" defaultValue={f.sort} className="h-9 w-48" aria-label="Sort">
          <option value="action">Needs action first</option><option value="left">Most left to advise</option><option value="value">Value (high first)</option>
          <option value="pending">Waiting (high first)</option><option value="name">Name</option><option value="onboarded">Newest onboarded</option>
        </Select>
        {(["status", "risk", "plan", "premium", "attention", "agreement", "min", "max"] as const).map((k) => one(k) ? <input key={k} type="hidden" name={k} value={one(k)} /> : null)}
        <Button type="submit" variant="outline" size="sm">Apply</Button>
        {activeFilters ? <Link href="/clients" className="text-xs text-muted hover:underline">Clear</Link> : null}
        <span className="ml-auto text-[11px] text-muted">More views: <Link className="hover:underline" href={viewHref({ premium: "renewal_due" })}>renewal due</Link> · <Link className="hover:underline" href={viewHref({ premium: "expired" })}>premium expired</Link> · <Link className="hover:underline" href={viewHref({ attention: "no_plan" })}>no active plan</Link> · tick clients for one action on all · click a column to sort</span>
      </form>

      <ClientList
        rows={clients.map(toRow)}
        isAdmin={isAdmin}
        canAdvise={actor.role !== "OPERATIONS"}
        advisors={advisors.map((a) => ({ id: a.id, name: a.full_name }))}
        deleteAction={deleteClientsAction}
        reassignAction={reassignClientsAction}
      />
    </>
  );
}

type Row = Awaited<ReturnType<typeof listDeskClients>>[number];

/** One client as the list shows it (plain data for the client-side table). */
function toRow(c: Row): ListRow {
  const target = c.target_sell + c.target_buy;
  const inBank = c.in_bank;
  const nextTranche = Boolean(c.active_plan_id) && c.pending_total < 0.5 && c.remaining_to_advise >= 0.5;
  const tranchesHref = `/clients/${c.client_id}?tab=tranches`;
  const tag: ListTag | null =
    c.status !== "ACTIVE" ? { text: humanize(c.status), tone: c.status === "ONBOARDING" ? "blue" : "grey" }
    : c.pending_total >= 0.5 ? { text: `${formatINRCompact(c.pending_total)} waiting for client`, tone: "amber", href: `${tranchesHref}&side=PENDING#ledger` }
    : nextTranche ? { text: "next tranche to advise", tone: "brand", href: tranchesHref }
    : null;
  const sub: ListTag[] = [];
  if (c.status !== "ACTIVE" && c.pending_total >= 0.5) sub.push({ text: `${formatINRCompact(c.pending_total)} waiting for client`, tone: "amber" });
  if (c.status !== "ACTIVE" && nextTranche) sub.push({ text: "next tranche to advise", tone: "brand", href: tranchesHref });
  if (c.follow_ups_due) sub.push({ text: `${c.follow_ups_due} follow-up`, tone: "amber", href: `/clients/${c.client_id}?tab=file#notes` });
  if (c.unadvised_to_review) sub.push({ text: `${c.unadvised_to_review} unadvised`, tone: "red", href: tranchesHref });
  if (c.cas_to_review) sub.push({ text: "CAS to check", tone: "amber", href: "/reconciliation" });
  if (c.has_draft_plan) sub.push({ text: "plan to approve", tone: "brand", href: tranchesHref });
  return {
    id: c.client_id, name: c.full_name, code: c.client_code, tag, subTags: sub,
    advisor: c.advisor_name ?? "—", risk: c.risk_profile ? humanize(c.risk_profile) : "—",
    valueToday: c.live_portfolio_value == null && inBank < 0.5 ? null : (c.live_portfolio_value ?? 0) + inBank,
    inFunds: c.live_portfolio_value, inBank,
    tranche: c.active_plan_id ? (target > 0 ? `Tranche ${Math.max(1, c.cas_count)}` : "No targets") : null,
    donePct: target > 0 ? Math.round(((c.executed_sell + c.executed_buy) / target) * 100) : null,
    advisedPct: target > 0 ? Math.round(((c.advised_sell + c.advised_buy) / target) * 100) : 0,
    left: c.remaining_to_advise, waiting: c.pending_total, sip: c.sip_monthly_target,
    premium: c.premium_paid_total,
    premiumNote: c.paid_until ? `${c.premium_status === "EXPIRED" ? "expired" : "till"} ${formatDate(c.paid_until)}` : c.premium_status === "UNPAID" ? "not recorded" : "no period",
    premiumTone: c.premium_status === "ACTIVE" ? (c.renewal_due ? "amber" : "green") : "red",
    agreementGap: c.agreement_status !== "VALID" ? `agreement ${c.agreement_status === "EXPIRED" ? "expired" : "missing"}` : null,
    latestCas: c.latest_cas_date, since: c.onboarding_date,
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
                    <td className="px-2 py-2 font-mono text-xs">{r.pan ?? "—"}</td>
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
