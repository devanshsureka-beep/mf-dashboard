import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { LinkButton } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import { EmptyState, PageHeader } from "@/components/app/page-header";
import { Money } from "@/components/app/money";
import { ActionBadge } from "@/components/app/status-badge";
import { formatDate, formatDayMonth, formatINRCompact, formatUnits, humanize, todayIST } from "@/lib/format";
import { cn } from "@/lib/utils";
import { HubTabs } from "@/components/app/hub-tabs";
import { PAGES } from "@/lib/brand";
import { pageData } from "@/lib/server";
import { listAdviceLedger } from "@/services/advice";
import { listAdvisors } from "@/services/clients";
import type { AdviceItemView } from "@/types/domain";
import { AutoForm } from "./find/find-search";

export const metadata = { title: "Tranches" };

type Row = AdviceItemView;
const CLOSED = ["CANCELLED", "EXPIRED", "REVISED"];
const PERIODS = { "30": "Last 30 days", today: "Today", month: "This month", "90": "Last 90 days", all: "All time" } as const;
type Period = keyof typeof PERIODS;

const timeIST = (d: Date) => new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" }).format(new Date(d));
const dayIST = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(d));

/** A tranche's state from its calls (revised / cancelled ones aside). */
function trancheState(rows: Row[]) {
  const live = rows.filter((r) => !CLOSED.includes(r.status));
  if (!live.length) return { key: "CANCELLED", label: "Cancelled / revised", cls: "bg-slate-100 text-slate-600" };
  if (live.every((r) => r.status === "EXECUTED")) return { key: "DONE", label: "Done", cls: "bg-emerald-700 text-white" };
  if (live.some((r) => r.executed_amount >= 0.5)) return { key: "PART", label: "Part done", cls: "bg-emerald-50 text-emerald-800" };
  return { key: "WAITING", label: "Waiting", cls: "bg-amber-50 text-amber-900" };
}

function callState(r: Row) {
  if (r.status === "REVISED") return { label: "Revised", cls: "bg-slate-100 text-slate-600" };
  if (r.status === "CANCELLED" || r.status === "EXPIRED") return { label: humanize(r.status), cls: "bg-slate-100 text-slate-600" };
  if (r.status === "EXECUTED") return { label: "Done", cls: "bg-emerald-700 text-white" };
  if (r.executed_amount >= 0.5) return { label: "Part done", cls: "bg-emerald-50 text-emerald-800" };
  return { label: "Not in CAS yet", cls: "bg-orange-50 text-orange-800" };
}

export default async function TranchesPage(props: PageProps<"/advice">) {
  const sp = await props.searchParams;
  const one = (k: string) => (typeof sp[k] === "string" && sp[k] ? (sp[k] as string) : null);
  const period: Period = (one("period") as Period) in PERIODS ? (one("period") as Period) : one("client") ? "all" : "30";
  const today = todayIST();
  const from = one("from") ?? (period === "today" ? today
    : period === "month" ? `${today.slice(0, 8)}01`
    : period === "all" ? null
    : new Date(new Date(`${today}T00:00:00Z`).getTime() - Number(period) * 86_400_000).toISOString().slice(0, 10));
  const f = { q: one("q"), state: one("state"), advisor: one("advisor"), client: one("client"), side: one("side") };

  const { rows, advisors, actor } = await pageData(async (tx) => ({
    rows: await listAdviceLedger(tx, {
      from, to: one("to"), advisorId: f.advisor, clientId: f.client,
      side: f.side === "BUY" || f.side === "SELL" ? f.side : null, limit: 2000,
    }),
    advisors: await listAdvisors(tx),
  }));

  // One tranche = one advice batch: everything told to one client at one moment.
  const byBatch = new Map<string, Row[]>();
  for (const r of rows) byBatch.set(r.advice_batch_id, [...(byBatch.get(r.advice_batch_id) ?? []), r]);
  const words = (f.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const tranches = [...byBatch.values()]
    .map((list) => ({ rows: list, first: list[0], state: trancheState(list) }))
    .filter((t) => !words.length || words.every((w) => t.rows.some((r) => `${r.client_name} ${r.client_code} ${r.scheme_name} ${r.batch_code}`.toLowerCase().includes(w))))
    .filter((t) => !f.state || (f.state === "open" ? ["WAITING", "PART"].includes(t.state.key) : f.state === "done" ? t.state.key === "DONE" : t.rows.some((r) => CLOSED.includes(r.status))));
  const days: { day: string; list: typeof tranches }[] = [];
  for (const t of tranches) {
    const d = dayIST(t.first.communicated_at);
    const g = days.find((x) => x.day === d);
    if (g) g.list.push(t); else days.push({ day: d, list: [t] });
  }

  const shown = tranches.flatMap((t) => t.rows);
  const live = (r: Row) => !CLOSED.includes(r.status);
  const sum = (pred: (r: Row) => boolean, k: "advised_amount" | "executed_amount" | "pending_amount") => shown.filter(pred).reduce((s, r) => s + Number(r[k]), 0);
  const qs = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...f, period, ...patch })) if (v) p.set(k, v);
    return `/advice?${p.toString()}`;
  };
  const chip = (label: string, state: string | null) => (
    <Link key={label} href={qs({ state })} aria-current={f.state === state ? "true" : undefined}
      className={cn("flex h-10 items-center rounded-full border px-4 text-[13px]", f.state === state ? "border-ink bg-ink text-white" : "border-border bg-white hover:bg-slate-50")}>{label}</Link>
  );
  const clientName = f.client ? rows.find((r) => r.client_id === f.client)?.client_name : null;
  const todayDay = today;

  return (
    <>
      <PageHeader
        title={PAGES.calls}
        subtitle="A tranche is one conversation: every call given to a client at that moment, together. Revised and cancelled calls stay visible."
        actions={actor.role !== "OPERATIONS" ? <LinkButton href="/advice/new">Issue call</LinkButton> : null}
      />
      <HubTabs hub="calls" active="ledger" role={actor.role} />
      {one("issued") ? <p className="mb-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">Calls recorded. They now show below and under Waiting; the next CAS marks them done.</p> : null}

      <AutoForm className="mb-3 flex flex-wrap items-center gap-2">
        {f.state ? <input type="hidden" name="state" value={f.state} /> : null}
        {f.client ? <input type="hidden" name="client" value={f.client} /> : null}
        <Input type="search" name="q" defaultValue={f.q ?? ""} placeholder="Search client, fund or tranche no. (Enter)" aria-label="Search client, fund or tranche number" className="h-10 min-w-[16rem] flex-1" />
        {chip("All", null)}
        {chip("Open", "open")}
        {chip("Done", "done")}
        {chip("Cancelled / revised", "closed")}
        <Select name="period" defaultValue={period} className="h-10 w-40" aria-label="Period">
          {Object.entries(PERIODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        <Select name="side" defaultValue={f.side ?? ""} className="h-10 w-32" aria-label="Buy or sell">
          <option value="">Buy &amp; sell</option><option value="BUY">Buy</option><option value="SELL">Sell</option>
        </Select>
        {actor.role !== "ADVISOR" ? (
          <Select name="advisor" defaultValue={f.advisor ?? ""} className="h-10 w-44" aria-label="Advisor">
            <option value="">All advisors</option>
            {advisors.map((a) => <option key={a.id} value={a.id}>{a.full_name}</option>)}
          </Select>
        ) : null}
      </AutoForm>
      {f.client ? <p className="mb-3 text-sm">Client: <b>{clientName ?? "selected client"}</b> <Link href={qs({ client: null })} className="ml-1 text-brand hover:underline">Show all clients</Link></p> : null}

      <div className="mb-4 flex flex-wrap gap-x-6 gap-y-1 text-[13.5px] text-slate-700">
        <span><b className="text-ink">{tranches.length} tranche{tranches.length === 1 ? "" : "s"}</b> · {shown.length} calls</span>
        <span>Sell advised <Money value={sum((r) => r.action !== "BUY" && live(r), "advised_amount")} className="font-semibold text-red-700" /></span>
        <span>Buy advised <Money value={sum((r) => r.action === "BUY" && live(r), "advised_amount")} className="font-semibold text-blue-700" /></span>
        <span>Done (CAS) <Money value={sum(() => true, "executed_amount")} className="font-semibold text-emerald-700" /></span>
        <span>Waiting <Money value={sum(() => true, "pending_amount")} className="font-semibold text-amber-700" /></span>
      </div>

      {days.length === 0 ? <EmptyState title="No tranche matches">Try another period, or clear the search.</EmptyState> : (
        <div className="space-y-5">
          {days.map((d) => (
            <section key={d.day}>
              <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted">{d.day === todayDay ? "Today · " : ""}{formatDate(d.day)}</h2>
              <div className="space-y-2">
                {d.list.map(({ rows: list, first, state }) => {
                  const counted = list.filter(live);
                  const advised = counted.reduce((t, r) => t + Number(r.advised_amount), 0);
                  const done = list.reduce((t, r) => t + Number(r.executed_amount), 0);
                  const sells = counted.filter((r) => r.action !== "BUY").reduce((t, r) => t + Number(r.advised_amount), 0);
                  const buys = counted.filter((r) => r.action === "BUY").reduce((t, r) => t + Number(r.advised_amount), 0);
                  const nDone = counted.filter((r) => r.status === "EXECUTED").length;
                  const closed = list.length - counted.length;
                  const pct = advised > 0 ? Math.min(100, Math.round((done / advised) * 100)) : 0;
                  const offPlan = list.every((r) => !r.plan_item_id);
                  return (
                    <details key={first.advice_batch_id} className={cn("group overflow-hidden rounded-xl border border-border bg-white", state.key === "CANCELLED" && "opacity-60")}>
                      <summary className="grid cursor-pointer list-none items-center gap-x-4 gap-y-2 px-4 py-3 md:grid-cols-[96px_minmax(0,2fr)_minmax(0,1.8fr)_minmax(0,2fr)_120px_40px] [&::-webkit-details-marker]:hidden">
                        <span><b className="block text-sm">{timeIST(first.communicated_at)}</b><span className="text-xs text-muted">{humanize(first.communication_channel)}</span></span>
                        <span className="min-w-0">
                          <Link href={`/clients/${first.client_id}`} className="text-[15px] font-semibold hover:underline">{first.client_name}</Link>
                          <span className="block truncate text-xs text-muted">{first.client_code}{first.advisor_name ? ` · ${first.advisor_name}` : ""} · {first.batch_code}{offPlan ? " · off-plan" : ""}</span>
                        </span>
                        <span className="text-[13px]">
                          <b>{list.length} call{list.length === 1 ? "" : "s"}{closed ? ` · ${closed} revised / cancelled` : ""}</b>
                          <span className="block text-muted">{[sells >= 0.5 ? `Sell ${formatINRCompact(sells)}` : "", buys >= 0.5 ? `Buy ${formatINRCompact(buys)}` : ""].filter(Boolean).join(" · ") || "—"}</span>
                        </span>
                        <span>
                          <span className="block h-2 overflow-hidden rounded-full bg-slate-200"><span className="block h-2 rounded-full bg-emerald-600" style={{ width: `${pct}%` }} /></span>
                          <span className="mt-1 block text-xs text-slate-600">{formatINRCompact(done)} of {formatINRCompact(advised)} done · {nDone} of {counted.length} call{counted.length === 1 ? "" : "s"}</span>
                        </span>
                        <span className={cn("justify-self-start rounded-full px-2.5 py-1 text-[12px] font-semibold", state.cls)}>{state.label}</span>
                        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-100" aria-hidden><ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" /></span>
                      </summary>
                      <ul className="border-t border-border bg-slate-50/60">
                        {list.map((r) => {
                          const cs = callState(r);
                          const cpct = Number(r.advised_amount) > 0 ? Math.min(100, Math.round((Number(r.executed_amount) / Number(r.advised_amount)) * 100)) : 0;
                          return (
                            <li key={r.id} className={cn("grid items-center gap-x-4 gap-y-1 border-b border-slate-100 px-4 py-2.5 text-[13px] last:border-b-0 md:grid-cols-[96px_minmax(0,2.6fr)_minmax(0,2fr)_130px_120px]", CLOSED.includes(r.status) && "opacity-60")}>
                              <span><ActionBadge action={r.action} /></span>
                              <span className="min-w-0">
                                <Link href={`/advice/items/${r.id}`} className="font-medium hover:underline">{r.scheme_name}</Link>
                                <span className="block text-[11.5px] text-muted">
                                  {r.quantity_basis === "UNITS" ? `${formatUnits(r.advised_units)} units · ` : ""}{r.plan_item_id ? "plan line" : "off-plan"}{r.revises_advice_item_id ? " · revision" : ""}{r.status_reason && CLOSED.includes(r.status) ? ` · ${r.status_reason}` : ""}
                                </span>
                              </span>
                              <span>
                                <span className="block h-1.5 overflow-hidden rounded-full bg-slate-200"><span className="block h-1.5 bg-emerald-600" style={{ width: `${cpct}%` }} /></span>
                                <span className="mt-1 block text-xs text-slate-600">{formatINRCompact(Number(r.executed_amount))} of {r.quantity_basis === "UNITS" ? "≈ " : ""}{formatINRCompact(Number(r.advised_amount))} done</span>
                              </span>
                              <span className="text-xs text-muted">{r.last_execution_date ? `done ${formatDayMonth(r.last_execution_date)}` : r.is_open ? `${r.age_days} day${r.age_days === 1 ? "" : "s"} open` : ""}</span>
                              <span className={cn("justify-self-start rounded-full px-2.5 py-1 text-[11.5px] font-semibold", cs.cls)}>{cs.label}</span>
                            </li>
                          );
                        })}
                      </ul>
                    </details>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
