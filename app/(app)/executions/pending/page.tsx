import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { LinkButton } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import { Money } from "@/components/app/money";
import { ActionBadge } from "@/components/app/status-badge";
import { EmptyState, PageHeader } from "@/components/app/page-header";
import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { formatDayMonth, formatINRCompact, formatUnits } from "@/lib/format";
import { askCasHref } from "@/lib/ask-cas";
import { cn, uuidOrNull } from "@/lib/utils";
import { PAGES } from "@/lib/brand";
import { HubTabs } from "@/components/app/hub-tabs";
import { pageData } from "@/lib/server";
import { getActivityMap, listAdvisors } from "@/services/clients";
import { ActiveDot } from "@/components/app/active-dot";
import { listWaiting, type WaitingCall } from "@/services/waiting";
import { AutoForm } from "../../advice/find/find-search";
import { closeAdviceAction, followUpNoteAction } from "../../advice/actions";

export const metadata = { title: "Waiting for clients" };

/** A call is "old" when the client has not acted on it for this many days. */
const OLD_DAYS = 21;

type Group = { client_id: string; client_name: string; client_code: string; phone: string | null; advisor: string | null; rows: WaitingCall[]; advised: number; done: number; waiting: number; oldest: number; toConfirm: boolean };

export default async function PendingExecutionsPage(props: PageProps<"/executions/pending">) {
  const sp = await props.searchParams;
  const one = (k: string) => (typeof sp[k] === "string" && sp[k] ? (sp[k] as string) : null);
  const f = { q: one("q"), advisor: uuidOrNull(one("advisor")), status: one("status"), side: one("side"), age: one("age"), open: one("open") };
  const { all, advisors, act, actor } = await pageData(async (tx) => {
    const all = await listWaiting(tx, { advisorId: f.advisor });
    return { all, advisors: await listAdvisors(tx), act: await getActivityMap(tx, all.map((r) => r.client_id)) };
  });
  const canAdvise = actor.role !== "OPERATIONS";

  // The tiles count everything waiting; the chips and search narrow the list below.
  const old = all.filter((r) => r.age_days > OLD_DAYS);
  const part = all.filter((r) => r.executed_amount >= 0.5);
  const toConfirm = all.filter((r) => r.to_confirm);
  const words = (f.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const rows = all
    .filter((r) => !words.length || words.every((w) => `${r.client_name} ${r.client_code} ${r.scheme_name} ${r.batch_code}`.toLowerCase().includes(w)))
    .filter((r) => f.side !== "SELL" || r.action !== "BUY")
    .filter((r) => f.side !== "BUY" || r.action === "BUY")
    .filter((r) => f.status !== "PARTIAL" || r.executed_amount >= 0.5)
    .filter((r) => f.status !== "PENDING" || r.executed_amount < 0.5)
    .filter((r) => f.age !== "old" || r.age_days > OLD_DAYS);

  const groups: Group[] = [];
  for (const r of rows) {
    let g = groups.find((x) => x.client_id === r.client_id);
    if (!g) groups.push((g = { client_id: r.client_id, client_name: r.client_name, client_code: r.client_code, phone: r.phone, advisor: r.primary_advisor_name ?? r.advisor_name, rows: [], advised: 0, done: 0, waiting: 0, oldest: 0, toConfirm: false }));
    g.rows.push(r);
    g.advised += r.advised_amount;
    g.done += r.executed_amount;
    g.waiting += r.pending_amount;
    g.oldest = Math.max(g.oldest, r.age_days);
    g.toConfirm ||= r.to_confirm;
  }
  groups.sort((a, b) => b.oldest - a.oldest);
  for (const g of groups) g.rows.sort((a, b) => b.age_days - a.age_days);

  const qs = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...f, ...patch })) if (v) p.set(k, v);
    const q = p.toString();
    return `/executions/pending${q ? `?${q}` : ""}`;
  };
  const tile = (label: string, value: React.ReactNode, sub: string, href: string, on: boolean, tone: string) => (
    <Link href={href} aria-current={on ? "true" : undefined}
      className={cn("flex min-h-[5.5rem] flex-col gap-0.5 rounded-xl border bg-white px-4 py-3 hover:border-brand", on ? "border-2 border-brand" : "border-border")}>
      <span className="text-[11.5px] font-semibold uppercase tracking-wide text-muted">{label}</span>
      <span className={cn("text-[22px] font-bold num", tone)}>{value}</span>
      <span className="text-xs text-muted">{sub}</span>
    </Link>
  );
  const chip = (label: string, patch: Record<string, string | null>, on: boolean) => (
    <Link key={label} href={qs(patch)} aria-current={on ? "true" : undefined}
      className={cn("flex h-10 items-center rounded-full border px-4 text-[13px]", on ? "border-ink bg-ink text-white" : "border-border bg-white hover:bg-slate-50")}>{label}</Link>
  );
  const sum = (list: WaitingCall[]) => list.reduce((t, r) => t + r.pending_amount, 0);
  const clients = new Set(all.map((r) => r.client_id)).size;

  return (
    <>
      <PageHeader
        title={PAGES.calls}
        subtitle={<><Money value={sum(all)} className="font-semibold text-amber-700" /> waiting across {clients} client{clients === 1 ? "" : "s"} · {all.length} call{all.length === 1 ? "" : "s"}. Nothing to record: Done fills in from each new CAS.</>}
        actions={canAdvise ? <LinkButton href="/advice/new">Issue call</LinkButton> : null}
      />
      <HubTabs hub="calls" active="pending" role={actor.role} counts={{ pending: all.length }} />

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        {tile("Waiting", formatINRCompact(sum(all)), `${all.length} calls · ${clients} clients`, qs({ age: null, status: null }), !f.age && !f.status, "text-amber-700")}
        {tile(`Older than ${OLD_DAYS} days`, `${old.length} call${old.length === 1 ? "" : "s"}`, `${formatINRCompact(sum(old))}: chase these first`, qs({ age: "old", status: null }), f.age === "old", "text-red-700")}
        {tile("Part done", `${part.length} call${part.length === 1 ? "" : "s"}`, "the CAS shows some of it", qs({ status: "PARTIAL", age: null }), f.status === "PARTIAL", "text-emerald-700")}
        {tile("CAS match to check", `${toConfirm.length} call${toConfirm.length === 1 ? "" : "s"}`, "one click each in the CAS inbox", "/reconciliation", false, toConfirm.length ? "text-red-700" : "text-ink")}
      </div>

      <AutoForm className="mb-4 flex flex-wrap items-center gap-2">
        {f.status ? <input type="hidden" name="status" value={f.status} /> : null}
        {f.age ? <input type="hidden" name="age" value={f.age} /> : null}
        {f.side ? <input type="hidden" name="side" value={f.side} /> : null}
        <Input type="search" name="q" defaultValue={f.q ?? ""} placeholder="Search client, fund or tranche no. (Enter)" aria-label="Search client, fund or tranche number" className="h-10 min-w-[16rem] flex-1" />
        {chip("All", { side: null, status: null, age: null }, !f.side && !f.status && !f.age)}
        {chip("Sell", { side: f.side === "SELL" ? null : "SELL" }, f.side === "SELL")}
        {chip("Buy", { side: f.side === "BUY" ? null : "BUY" }, f.side === "BUY")}
        {chip("Not in CAS yet", { status: f.status === "PENDING" ? null : "PENDING" }, f.status === "PENDING")}
        {actor.role !== "ADVISOR" ? (
          <Select name="advisor" defaultValue={f.advisor ?? ""} className="h-10 w-44" aria-label="Advisor">
            <option value="">All advisors</option>
            {advisors.map((a) => <option key={a.id} value={a.id}>{a.full_name}</option>)}
          </Select>
        ) : null}
      </AutoForm>

      {groups.length === 0 ? <EmptyState title={all.length ? "No call matches" : "Nothing waiting"}>{all.length ? "Clear the search or a chip." : "Every issued call has shown up in a CAS, or was cancelled or expired."}</EmptyState> : (
        <div className="space-y-2.5">
          {groups.map((g, gi) => {
            const pct = g.advised > 0 ? Math.min(100, Math.round((g.done / g.advised) * 100)) : 0;
            const sells = g.rows.filter((r) => r.action !== "BUY").reduce((t, r) => t + r.advised_amount, 0);
            const buys = g.rows.filter((r) => r.action === "BUY").reduce((t, r) => t + r.advised_amount, 0);
            return (
              <details key={g.client_id} open={f.open === g.client_id || (groups.length <= 3 && gi === 0) || undefined} className="group overflow-hidden rounded-xl border border-border bg-white">
                <summary className="grid cursor-pointer list-none items-center gap-x-4 gap-y-2 px-4 py-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1.6fr)_minmax(0,2fr)_88px_auto] [&::-webkit-details-marker]:hidden">
                  <span className="min-w-0">
                    <Link href={`/clients/${g.client_id}`} className="text-[15px] font-semibold hover:underline"><ActiveDot active={act[g.client_id]?.is_active} since={act[g.client_id]?.first_advised_at} />{g.client_name}</Link>
                    <span className="block text-xs text-muted">{g.client_code}{g.advisor ? ` · ${g.advisor}` : ""}</span>
                  </span>
                  <span className="text-[13px]">
                    <b>{g.rows.length} call{g.rows.length === 1 ? "" : "s"}</b>
                    <span className="block text-muted">{[sells >= 0.5 ? `Sell ${formatINRCompact(sells)}` : "", buys >= 0.5 ? `Buy ${formatINRCompact(buys)}` : ""].filter(Boolean).join(" · ")}</span>
                  </span>
                  <span>
                    <span className="block h-2 overflow-hidden rounded-full bg-slate-200"><span className="block h-2 rounded-full bg-emerald-600" style={{ width: `${pct}%` }} /></span>
                    <span className="mt-1 block text-xs text-slate-600">{formatINRCompact(g.done)} of {formatINRCompact(g.advised)} done · <b className="text-amber-700">{formatINRCompact(g.waiting)} waiting</b></span>
                  </span>
                  <span>
                    <b className={cn("block text-[15px]", g.oldest > OLD_DAYS ? "text-red-700" : "text-slate-700")}>{g.oldest} day{g.oldest === 1 ? "" : "s"}</b>
                    <span className="text-[11px] text-muted">oldest call</span>
                  </span>
                  <span className="flex flex-wrap items-center justify-end gap-2 text-[13px]">
                    {g.toConfirm ? <Link href="/reconciliation" className="flex h-9 items-center rounded-lg bg-amber-50 px-3 font-semibold text-amber-900 hover:underline">CAS match to check</Link> : null}
                    <a href={askCasHref({ client_id: g.client_id, full_name: g.client_name, phone: g.phone })} target="_blank" rel="noreferrer" className="flex h-9 items-center rounded-lg border border-border px-3 hover:bg-slate-50">Ask for CAS</a>
                    <Link href={`/clients/${g.client_id}/cas/upload`} className="flex h-9 items-center rounded-lg border border-border px-3 hover:bg-slate-50">Upload CAS</Link>
                    <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-100" aria-hidden><ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" /></span>
                  </span>
                </summary>
                <ul className="border-t border-border">
                  {g.rows.map((r) => {
                    const cpct = r.advised_amount > 0 ? Math.min(100, Math.round((r.executed_amount / r.advised_amount) * 100)) : 0;
                    const st = r.to_confirm ? { label: "CAS match to check", cls: "bg-amber-50 text-amber-900", href: "/reconciliation" }
                      : r.executed_amount >= 0.5 ? { label: "Part done", cls: "bg-emerald-50 text-emerald-800", href: null }
                      : r.age_days === 0 ? { label: "Told today", cls: "bg-slate-100 text-slate-700", href: null }
                      : { label: r.cas_after ? `Not in CAS ${formatDayMonth(r.cas_after)}` : "Not in CAS yet", cls: "bg-orange-50 text-orange-800", href: null };
                    return (
                      <li key={r.advice_item_id} className="border-b border-slate-100 last:border-b-0">
                        <div className="grid items-center gap-x-4 gap-y-1 px-4 py-2.5 text-[13px] md:grid-cols-[96px_minmax(0,2.4fr)_minmax(0,2fr)_150px_auto]">
                          <span><span className="block">{formatDayMonth(r.communicated_at)}</span><span className={cn("text-[11.5px] font-semibold", r.age_days > OLD_DAYS ? "text-red-700" : "text-muted")}>{r.age_days === 0 ? "today" : `${r.age_days} days`}</span></span>
                          <span className="min-w-0"><ActionBadge action={r.action} /> <span className="font-medium">{r.scheme_name}</span>
                            <span className="block text-[11.5px] text-muted">{r.communication_channel.replace("_", " ").toLowerCase()} · {r.batch_code}{r.quantity_basis === "UNITS" ? ` · ${formatUnits(r.advised_units)} units` : ""}</span></span>
                          <span>
                            <span className="block h-1.5 overflow-hidden rounded-full bg-slate-200"><span className="block h-1.5 bg-emerald-600" style={{ width: `${cpct}%` }} /></span>
                            <span className="mt-1 block text-xs text-slate-600">{formatINRCompact(r.executed_amount)} of {r.quantity_basis === "UNITS" ? "≈ " : ""}{formatINRCompact(r.advised_amount)} done{r.executed_amount >= 0.5 ? ` · ${formatINRCompact(r.pending_amount)} waiting` : ""}</span>
                          </span>
                          {st.href ? <Link href={st.href} className={cn("justify-self-start rounded-full px-2.5 py-1 text-[11.5px] font-semibold hover:underline", st.cls)}>{st.label}</Link>
                            : <span className={cn("justify-self-start rounded-full px-2.5 py-1 text-[11.5px] font-semibold", st.cls)}>{st.label}</span>}
                          <details className="relative justify-self-end">
                            <summary className="flex h-9 cursor-pointer list-none items-center rounded-lg px-3 text-muted hover:bg-slate-100 [&::-webkit-details-marker]:hidden" aria-label="More for this call">···</summary>
                            <div className="absolute right-0 z-20 mt-1 w-96 space-y-3 rounded-xl border border-border bg-white p-3 text-xs shadow-xl">
                              <Link className="text-brand hover:underline" href={`/advice/items/${r.advice_item_id}`}>Open the call</Link>
                              <ActionForm action={followUpNoteAction.bind(null, r.client_id, r.advice_item_id)} className="space-y-2" resetOnSuccess>
                                <Input name="body" placeholder="Follow-up note" required />
                                <Input type="date" name="follow_up_date" />
                                <SubmitButton size="sm" variant="outline">Add follow-up note</SubmitButton>
                              </ActionForm>
                              {canAdvise ? (
                                <ActionForm action={closeAdviceAction.bind(null, r.advice_item_id)} className="space-y-2 border-t border-border pt-2">
                                  <input type="hidden" name="status" value="CANCELLED" />
                                  <Input name="reason" placeholder="Reason to cancel (required)" required />
                                  <SubmitButton size="sm" variant="danger" confirm="Cancel the remaining part of this call?">Cancel advice</SubmitButton>
                                </ActionForm>
                              ) : null}
                            </div>
                          </details>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </details>
            );
          })}
        </div>
      )}
    </>
  );
}
