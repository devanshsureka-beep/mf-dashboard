import Link from "next/link";
import { LinkButton } from "@/components/ui/button";
import { Money } from "@/components/app/money";
import { DropMenu, MenuItem } from "@/components/app/drop-menu";
import { BookTrend } from "@/components/app/book-trend";
import { AllocationDonut } from "@/components/app/allocation-donut";
import { PAGES } from "@/lib/brand";
import { formatDate, formatINRCompact } from "@/lib/format";
import { pageData } from "@/lib/server";
import { cn } from "@/lib/utils";
import { assetClass, GROUP_BYS, groupBook, insights, shortCategory, slices, type GroupBy, type GroupNode } from "@/lib/domain/book";
import { listDeskClients } from "@/services/clients";
import { listDueFollowUps } from "@/services/notes";
import { listDraftPlans } from "@/services/plans";
import { getBookHoldings, getBookTrend } from "@/services/book";

export const metadata = { title: PAGES.overview };

function greeting(now = new Date()): string {
  const hour = Number(new Intl.DateTimeFormat("en-IN", { hour: "numeric", hourCycle: "h23", timeZone: "Asia/Kolkata" }).format(now));
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}

const todayIst = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

const ALLOCS = [{ key: "class", label: "Asset class" }, { key: "category", label: "Category" }, { key: "amc", label: "AMC" }] as const;
type Alloc = (typeof ALLOCS)[number]["key"];

function Kpi({ label, value, hint, tone, href }: { label: string; value: React.ReactNode; hint: React.ReactNode; tone?: string; href: string }) {
  return (
    <Link href={href} className="min-w-0 rounded-xl border border-border bg-surface px-4 py-3 hover:border-brand-200">
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted">{label}</div>
      <div className={cn("mt-0.5 text-2xl font-bold tracking-tight num", tone)}>{value}</div>
      <div className="truncate text-xs text-muted">{hint}</div>
    </Link>
  );
}

/** One kind of work: count, what it is, one button. Yellow when it is something to check. */
function Work({ n, title, sub, href, cta, review }: { n: number; title: string; sub: React.ReactNode; href: string; cta: string; review?: boolean }) {
  return (
    <Link href={href} className={cn("grid grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-3.5 py-3 ring-1", review ? "bg-amber-50 ring-amber-300 hover:bg-amber-100/60" : "bg-white ring-border hover:ring-brand-200")}>
      <span className={cn("grid h-9 w-9 place-items-center rounded-full font-bold text-white", review ? "bg-amber-600" : "bg-brand")}>{n}</span>
      <span className="min-w-0"><b className="text-sm">{title}</b><span className="block truncate text-xs text-slate-600">{sub}</span></span>
      <span className={cn("text-[13px] font-semibold", review ? "text-amber-800" : "text-brand")}>{cta} →</span>
    </Link>
  );
}

function Bar({ label, color, done, target, note }: { label: string; color: string; done: number; target: number; note: React.ReactNode }) {
  const pct = target > 0 ? Math.min(100, Math.round((done / target) * 100)) : 0;
  return (
    <div>
      <div className="flex justify-between text-[13px]"><b className={color}>{label}</b><span className="text-slate-600">{formatINRCompact(done)} of {formatINRCompact(target)} · {pct}%</span></div>
      <div className="mt-1 h-1.5 rounded-full bg-slate-100"><div className="h-1.5 rounded-full bg-emerald-500" style={{ width: `${pct}%` }} /></div>
      <div className="mt-1 text-xs text-muted">{note}</div>
    </div>
  );
}

function Group({ g, depth }: { g: GroupNode; depth: number }) {
  const row = (
    <span className="grid grid-cols-[minmax(0,1fr)_70px_100px_140px] items-center gap-3">
      <span className={cn("truncate", depth === 0 && "font-semibold")}>
        {g.children.length ? <span aria-hidden className="mr-1 inline-block w-3 text-muted group-open:rotate-90">▸</span> : <span className="mr-1 inline-block w-3" />}
        {g.href && !g.children.length ? <Link href={g.href} className="hover:underline">{g.label}</Link> : g.label}
      </span>
      <span className="text-right text-xs text-slate-600 num">{g.clients}</span>
      <span className="text-right font-semibold num">{formatINRCompact(g.value)}</span>
      <span>
        <span className="block h-1.5 rounded-full bg-slate-100"><span className="block h-1.5 rounded-full bg-[#2a78d6]" style={{ width: `${Math.max(1, Math.round(g.share * 100))}%` }} /></span>
        <span className="text-[11px] text-muted">{(g.share * 100).toFixed(1)}% of book</span>
      </span>
    </span>
  );
  const pad = { paddingLeft: `${16 + depth * 20}px` };
  if (!g.children.length) return <div className="border-t border-border py-2 pr-4 text-[13px]" style={pad}>{row}</div>;
  return (
    <details className="group">
      <summary className={cn("cursor-pointer list-none border-t border-border py-2 pr-4 text-[13px] hover:bg-slate-50 [&::-webkit-details-marker]:hidden", depth === 0 && "bg-slate-50/60")} style={pad}>{row}</summary>
      {g.children.slice(0, 25).map((c) => <Group key={c.key} g={c} depth={depth + 1} />)}
      {g.children.length > 25 ? <div className="border-t border-border py-2 text-xs text-muted" style={{ paddingLeft: `${36 + depth * 20}px` }}>+ {g.children.length - 25} more</div> : null}
    </details>
  );
}

export default async function Today(props: PageProps<"/">) {
  const sp = await props.searchParams;
  const mine = sp.mine === "1";
  const alloc: Alloc = ALLOCS.some((a) => a.key === sp.alloc) ? (sp.alloc as Alloc) : "class";
  const by: GroupBy = GROUP_BYS.some((g) => g.key === sp.by) ? (sp.by as GroupBy) : "category";
  const day = todayIst();
  const { all, sip, followUps, casStats, draftPlans, holdings, trend, actor } = await pageData(async (tx, a) => {
    const adv = mine ? a.id : null;
    const all = await listDeskClients(tx, mine ? { advisorId: a.id } : {});
    const live = all.reduce((t, c) => t + (c.live_portfolio_value ?? 0), 0);
    return {
      all,
      draftPlans: await listDraftPlans(tx, { advisorId: adv }),
      sip: (await tx<{ target: number; started: number }[]>`
        select coalesce(sum(v.sip_monthly_target), 0)::float8 as target, coalesce(sum(v.sip_monthly_started), 0)::float8 as started
        from public.v_client_sip v join public.v_client_summary s on s.client_id = v.client_id
        where (${adv}::uuid is null or s.advisor_id = ${adv})`)[0],
      followUps: await listDueFollowUps(tx, 5),
      // What the CAS uploads of the last 30 days did on their own, and what they left for a person.
      casStats: (await tx<{ done: number; confirm: number }[]>`
        select count(*) filter (where m.status in ('CONFIRMED', 'PARTIAL') and coalesce(m.resolved_at, r.created_at) > now() - interval '30 days')::int as done,
               count(*) filter (where m.status = 'SUGGESTED')::int as confirm
        from public.reconciliation_matches m join public.reconciliation_runs r on r.id = m.run_id
        join public.v_client_summary s on s.client_id = m.client_id
        where m.classification = 'ADVICE_MATCH' and r.status <> 'CANCELLED' and (${adv}::uuid is null or s.advisor_id = ${adv})`)[0] ?? { done: 0, confirm: 0 },
      holdings: await getBookHoldings(tx, adv),
      trend: await getBookTrend(tx, adv, live, all.filter((c) => c.live_portfolio_value != null).length),
    };
  });

  const sum = (f: (c: (typeof all)[number]) => number) => all.reduce((s, c) => s + f(c), 0);
  const awaiting = all.filter((c) => c.pending_total >= 0.5);
  const toCheck = all.filter((c) => c.cas_to_review > 0);
  const unadvised = all.filter((c) => c.unadvised_to_review > 0);
  const nextTranche = all.filter((c) => c.active_plan_id && c.pending_total < 0.5 && c.remaining_to_advise >= 0.5);
  const quiet = nextTranche.filter((c) => c.last_call_days == null || c.last_call_days > 14);
  const drafts = draftPlans;
  const draftQuestions = drafts.filter((d) => d.open_questions || d.needs_review).length;
  const oldestDraft = Math.max(-1, ...all.filter((c) => c.has_draft_plan).map((c) => c.draft_days ?? 0));
  const noAgreement = all.filter((c) => c.agreement_status !== "VALID");
  const inBankClients = all.filter((c) => c.in_bank >= 0.5);
  const canAdvise = actor.role !== "OPERATIONS";
  const inFunds = sum((c) => c.live_portfolio_value ?? 0);
  const left = sum((c) => (c.active_plan_id ? c.remaining_to_advise : 0));
  const casOpen = toCheck.length + unadvised.length + casStats.confirm;
  const kinds = [casOpen, drafts.length, nextTranche.length, awaiting.length, followUps.length].filter(Boolean).length;
  const firstTrend = trend.find((p) => p.value > 0);
  const total = holdings.reduce((t, h) => t + h.value, 0);
  const allocation = slices(holdings, alloc === "class" ? (h) => assetClass(h.category, h.scheme_name) : alloc === "category" ? (h) => shortCategory(h.category, h.scheme_name) : (h) => h.amc ?? "Unknown AMC", 8);
  const watch = insights(holdings, { inBank: sum((c) => c.in_bank), inBankClients: inBankClients.length });
  const groups = groupBook(holdings, by);
  const sellsLeft = all.filter((c) => c.active_plan_id && c.yet_to_advise_sell >= 0.5).sort((a, b) => b.yet_to_advise_sell - a.yet_to_advise_sell);
  const href = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams();
    if (mine) p.set("mine", "1");
    if (alloc !== "class") p.set("alloc", alloc);
    if (by !== "category") p.set("by", by);
    for (const [k, v] of Object.entries(patch)) { if (v) p.set(k, v); else p.delete(k); }
    const s = p.toString();
    return `/${s ? `?${s}` : ""}`;
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-brand-600">{formatDate(day)}</div>
          <h1 className="text-2xl font-semibold tracking-tight">{greeting()}, {actor.fullName.split(" ")[0] || "there"}</h1>
          <p className="mt-0.5 text-sm text-muted">{kinds ? `${kinds} kind${kinds === 1 ? "" : "s"} of work today.${casOpen ? " Start with the CAS: it decides what is left to advise." : ""}` : "Nothing waiting for you right now."}</p>
        </div>
        <div className="flex items-center gap-2">
          {actor.role !== "ADVISOR" ? (
            <div className="flex rounded-md border border-border bg-white p-0.5 text-xs">
              <Link href={href({ mine: null })} className={cn("rounded px-2.5 py-1", !mine ? "bg-ink text-white" : "text-slate-600")}>All advisors</Link>
              <Link href={href({ mine: "1" })} className={cn("rounded px-2.5 py-1", mine ? "bg-ink text-white" : "text-slate-600")}>My clients</Link>
            </div>
          ) : null}
          {canAdvise ? (
            <DropMenu label="Issue call" primary align="right">
              <MenuItem href="/advice/new?side=SELL"><b className="text-red-700">Sell call</b></MenuItem>
              <MenuItem href="/advice/new?side=BUY"><b className="text-blue-700">Buy call</b></MenuItem>
              <MenuItem href="/advice/bulk" hint="Same call for several clients">Call many clients</MenuItem>
            </DropMenu>
          ) : <LinkButton href="/reconciliation">Upload CAS</LinkButton>}
        </div>
      </div>

      {/* The book: the same six numbers as before, each opens its list. */}
      <section aria-label={mine ? "Your clients" : "The book"} className="mb-4">
        <h2 className="mb-2 text-sm font-semibold">{mine ? "Your clients" : "The book"}</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Kpi label="Clients" value={all.length} hint={`${all.filter((c) => c.active_plan_id).length} with an active plan`} href="/clients" />
          <Kpi label="In funds" value={<Money value={inFunds} />} hint="units × today's NAV" href="#book" />
          <Kpi label="Left to advise" value={<Money value={left} />} tone="text-brand-700" hint="all open tranches" href="/clients?attention=tranche" />
          <Kpi label="Waiting for clients" value={<Money value={sum((c) => c.pending_total)} />} tone={awaiting.length ? "text-amber-700" : "text-emerald-700"} hint={`advised, not done · ${awaiting.length} client(s)`} href="/executions/pending" />
          <Kpi label="In bank" value={<Money value={sum((c) => c.in_bank)} />} hint="sold, not bought back" href="/advice/find?list=cash" />
          <Kpi label="Plans to approve" value={drafts.length} tone={drafts.length ? "text-amber-700" : undefined} hint="drafts waiting" href="/clients?plan=draft" />
        </div>
      </section>

      <div className="grid items-start gap-4 xl:grid-cols-[5fr_7fr]">
        <div className="space-y-4">
          <section aria-label="Today's work" className="space-y-2.5 rounded-xl border border-border bg-surface p-4">
            <div className="flex items-baseline justify-between"><h2 className="text-[15px] font-semibold">Today&rsquo;s work</h2><span className="text-xs text-muted">in the order to do it</span></div>
            {casOpen ? <Work review n={casOpen} title={PAGES.casInbox} href="/reconciliation" cta="Open inbox"
              sub={<>{toCheck.length} CAS to check · {casStats.confirm} call(s) to confirm · {unadvised.length} with trades to decide</>} /> : null}
            {awaiting.length ? <Work review n={awaiting.length} title="Waiting for clients" href="/executions/pending" cta="See calls"
              sub={<><Money value={sum((c) => c.pending_total)} /> advised, not in a CAS yet</>} /> : null}
            {drafts.length ? <Work n={drafts.length} title="Drafts to approve" href="/clients?plan=draft" cta="Review"
              sub={<>{drafts.length - draftQuestions} ready · {draftQuestions} with questions{oldestDraft >= 0 ? ` · oldest ${oldestDraft} day(s)` : ""}</>} /> : null}
            {nextTranche.length ? <Work n={nextTranche.length} title="Next tranche to advise" href={canAdvise ? "/advice/find?list=all" : "/clients?attention=tranche"} cta={canAdvise ? "Start round" : "See clients"}
              sub={<><Money value={nextTranche.reduce((s, c) => s + c.remaining_to_advise, 0)} /> left · {quiet.length} quiet over 14 days</>} /> : null}
            {followUps.length ? <Work n={followUps.length} title="Follow-ups due" href="/clients?attention=follow_up" cta="Open"
              sub={followUps.slice(0, 3).map((n) => n.client_name).join(", ")} /> : null}
            <p className="px-1 text-xs text-emerald-700">
              {[!casOpen && "CAS inbox", !awaiting.length && "waiting on clients", !drafts.length && "drafts", !followUps.length && "follow-ups"].filter(Boolean).length
                ? `All clear: ${[!casOpen && "CAS inbox", !awaiting.length && "waiting on clients", !drafts.length && "drafts", !followUps.length && "follow-ups"].filter(Boolean).join(", ")}`
                : null}
            </p>
            {noAgreement.length || all.some((c) => c.renewal_due) ? (
              <Link href="/clients?agreement=missing" className="block px-1 text-xs text-muted hover:underline">
                Admin: {noAgreement.length} without an agreement · {all.filter((c) => c.renewal_due).length} renewal(s) due →
              </Link>
            ) : null}
          </section>

          <section aria-label="Rebalancing" className="space-y-3.5 rounded-xl border border-border bg-surface p-4">
            <div className="flex items-baseline justify-between"><h2 className="text-[15px] font-semibold">Rebalancing across all plans</h2><Link href="/advice" className="text-xs text-brand hover:underline">by client →</Link></div>
            <Bar label="Sell" color="text-red-700" done={sum((c) => c.executed_sell)} target={sum((c) => c.target_sell)}
              note={sellsLeft.length ? <>Most left: {sellsLeft.slice(0, 3).map((c) => <Link key={c.client_id} href={`/clients/${c.client_id}?tab=tranches`} className="hover:underline">{c.full_name} {formatINRCompact(c.yet_to_advise_sell)}</Link>).reduce<React.ReactNode[]>((acc, el, i) => (i ? [...acc, ", ", el] : [el]), [])}</> : "No sells left to advise"} />
            <Bar label="Buy" color="text-blue-700" done={sum((c) => c.executed_buy)} target={sum((c) => c.target_buy)}
              note={sum((c) => c.in_bank) >= 0.5 ? <><Money value={sum((c) => c.in_bank)} /> sold and in bank with {inBankClients.length} client(s), ready to buy</> : "No sale money waiting in bank"} />
            <Bar label="SIP / month" color="text-violet-700" done={sip.started} target={sip.target}
              note={sip.target - sip.started >= 0.5 ? <><Money value={sip.target - sip.started} /> a month still to start</> : "Every planned SIP is running"} />
          </section>
        </div>

        <section id="book" aria-label="The book over time" className="space-y-4 rounded-xl border border-border bg-surface p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-[15px] font-semibold">Money in funds, month by month</h2>
            {firstTrend ? <span className="text-xs text-slate-600">{formatINRCompact(firstTrend.value)} ({firstTrend.clients} client{firstTrend.clients === 1 ? "" : "s"}) → <b className="text-ink">{formatINRCompact(trend[trend.length - 1].value)}</b> ({trend[trend.length - 1].clients}) · new clients, new money and the market</span> : null}
          </div>
          <BookTrend points={trend} />
          <p className="-mt-2 text-[11px] text-muted">Each month: every client&rsquo;s latest confirmed CAS by then. This month: units × today&rsquo;s NAV.</p>
          <div className="border-t border-border pt-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Allocation</h3>
              <span className="flex rounded-md border border-border bg-white p-0.5 text-xs">
                {ALLOCS.map((a) => <Link key={a.key} href={`${href({ alloc: a.key === "class" ? null : a.key })}#book`} className={cn("rounded px-2.5 py-1", alloc === a.key ? "bg-ink text-white" : "text-slate-600")}>{a.label}</Link>)}
              </span>
            </div>
            {total > 0 ? <AllocationDonut slices={allocation} total={total} /> : <p className="text-sm text-muted">No confirmed CAS yet.</p>}
          </div>
        </section>
      </div>

      {watch.length ? (
        <section aria-label="Worth a look" className="mt-4 rounded-xl border border-border bg-surface p-4">
          <div className="flex items-baseline justify-between"><h2 className="text-[15px] font-semibold">Worth a look</h2><span className="text-xs text-muted">risks in the book no plan covers yet</span></div>
          <ul className="mt-1">
            {watch.map((w) => (
              <li key={w.title} className="grid grid-cols-[6px_minmax(0,1fr)_auto] items-center gap-3 border-t border-border py-3 first:border-t-0">
                <span className={cn("h-9 w-1.5 rounded-full", w.tone === "review" ? "bg-amber-500" : "bg-brand")} aria-hidden />
                <span className="min-w-0">
                  <b className="text-sm">{w.title}</b>
                  <span className="block truncate text-xs text-muted">{w.detail}</span>
                  {w.clients.length ? <span className="mt-0.5 flex flex-wrap gap-x-2 text-xs">{w.clients.map((c) => <Link key={c.id} href={`/clients/${c.id}`} className="text-brand hover:underline">{c.name}</Link>)}</span> : null}
                </span>
                {w.href ? <Link href={w.href} className="text-xs font-medium text-brand hover:underline">Open →</Link> : <span />}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section id="by" aria-label="Look at the book by" className="mt-4 overflow-hidden rounded-xl border border-border bg-surface">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3">
          <h2 className="flex-1 text-[15px] font-semibold">Look at the book by</h2>
          <span className="flex flex-wrap rounded-md border border-border bg-slate-50 p-0.5 text-xs">
            {GROUP_BYS.map((g) => <Link key={g.key} href={`${href({ by: g.key === "category" ? null : g.key })}#by`} className={cn("rounded px-2.5 py-1", by === g.key ? "bg-white font-semibold shadow-sm" : "text-slate-600")}>{g.label}</Link>)}
          </span>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_70px_100px_140px] gap-3 border-t border-border px-4 py-2 text-[10.5px] font-semibold uppercase tracking-wide text-muted">
          <span>Name</span><span className="text-right">Clients</span><span className="text-right">In funds</span><span>Share</span>
        </div>
        {groups.length ? groups.map((g) => <Group key={g.key} g={g} depth={0} />) : <p className="border-t border-border p-4 text-sm text-muted">No confirmed CAS yet.</p>}
      </section>
    </>
  );
}
