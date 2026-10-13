import Link from "next/link";
import { LinkButton } from "@/components/ui/button";
import { Money } from "@/components/app/money";
import { ActionBadge } from "@/components/app/status-badge";
import { DropMenu, MenuItem } from "@/components/app/drop-menu";
import { PAGES } from "@/lib/brand";
import { formatDate, formatINRCompact } from "@/lib/format";
import { pageData } from "@/lib/server";
import { cn } from "@/lib/utils";
import { listDeskClients } from "@/services/clients";
import { listDueFollowUps } from "@/services/notes";
import type { AdviceAction } from "@/types/domain";

export const metadata = { title: PAGES.overview };

function greeting(now = new Date()): string {
  const hour = Number(new Intl.DateTimeFormat("en-IN", { hour: "numeric", hourCycle: "h23", timeZone: "Asia/Kolkata" }).format(now));
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}

const todayIst = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

function Stat({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-muted">{label}</div>
      <div className={cn("text-xl font-semibold tracking-tight num", tone)}>{value}</div>
      {hint ? <div className="text-[11px] text-muted">{hint}</div> : null}
    </div>
  );
}

function Bar({ label, color, done, target, unit = "" }: { label: string; color: string; done: number; target: number; unit?: string }) {
  const pct = target > 0 ? Math.min(100, Math.round((done / target) * 100)) : 0;
  return (
    <div>
      <div className="flex justify-between text-xs"><span className={cn("font-semibold", color)}>{label}</span><span className="text-muted">{formatINRCompact(done)}{unit} of {formatINRCompact(target)}{unit} · {pct}%</span></div>
      <div className="mt-1 h-1.5 rounded-full bg-slate-100"><div className="h-1.5 rounded-full bg-emerald-500" style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

function Queue({ n, tone, title, sub, href, linkLabel, children }: { n: number; tone: string; title: string; sub: React.ReactNode; href: string; linkLabel: string; children?: React.ReactNode }) {
  return (
    <article className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className={cn("flex items-center justify-between gap-3 px-4 py-3", children ? "border-b border-border" : "")}>
        <div className="flex items-center gap-3">
          <span className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-full text-sm font-bold", tone)}>{n}</span>
          <div><div className="font-semibold">{title}</div><div className="text-xs text-muted">{sub}</div></div>
        </div>
        <Link href={href} className="shrink-0 text-xs font-medium text-brand hover:underline">{linkLabel} →</Link>
      </div>
      {children}
    </article>
  );
}

export default async function Today(props: PageProps<"/">) {
  const sp = await props.searchParams;
  const mine = sp.mine === "1";
  const day = todayIst();
  const { all, calls, openCalls, stale, week, recent, sip, followUps, actor } = await pageData(async (tx, a) => ({
    all: await listDeskClients(tx, mine ? { advisorId: a.id } : {}),
    calls: await tx<{ advice_item_id: string; client_id: string; client_name: string; client_code: string; scheme_name: string; action: AdviceAction; pending_amount: number; age_days: number }[]>`
      select advice_item_id, client_id, client_name, client_code, scheme_name, action, pending_amount::float8 as pending_amount, age_days
      from public.v_pending_executions where (${mine} = false or advisor_id = ${a.id}) order by age_days desc, communicated_at limit 5`,
    week: await tx<{ d: string; advised: number; executed: number }[]>`
      with days as (select (app.today_ist() - g)::date as d from generate_series(0, 6) g)
      select d::text as d,
             coalesce((select sum(v.effective_advised_amount) from public.v_advice_items v
                       where (v.communicated_at at time zone 'Asia/Kolkata')::date = days.d and (${mine} = false or v.advisor_id = ${a.id})), 0)::float8 as advised,
             coalesce((select sum(e.executed_amount) from public.executions e join public.v_advice_items ai on ai.id = e.advice_item_id
                       where e.execution_date = days.d and e.status in ('EXECUTED', 'PARTIAL') and (${mine} = false or ai.advisor_id = ${a.id})), 0)::float8 as executed
      from days order by d`,
    recent: await tx<{ at: Date; kind: string; text: string; client_id: string; client_name: string }[]>`
      (select v.communicated_at as at, 'Call' as kind, initcap(v.action) || ' ' || v.scheme_name as text, v.client_id, c.full_name as client_name
       from public.v_advice_items v join public.clients c on c.id = v.client_id order by v.communicated_at desc limit 4)
      union all
      (select e.created_at, 'Execution', 'Executed ₹' || to_char(e.executed_amount, 'FM99,99,99,999') || ' · ' || coalesce(sm.scheme_name, ''), e.client_id, c.full_name
       from public.executions e join public.clients c on c.id = e.client_id left join public.security_master sm on sm.id = e.security_id
       order by e.created_at desc limit 4)
      union all
      (select s.created_at, 'CAS', 'CAS of ' || to_char(s.snapshot_date, 'DD-Mon') || ' ' || lower(replace(s.review_status, '_', ' ')), s.client_id, c.full_name
       from public.portfolio_snapshots s join public.clients c on c.id = s.client_id order by s.created_at desc limit 4)
      order by at desc limit 6`,
    openCalls: Number((await tx<{ n: number }[]>`select count(*)::int as n from public.v_pending_executions where (${mine} = false or advisor_id = ${a.id})`)[0]?.n ?? 0),
    stale: Number((await tx<{ n: number }[]>`select count(*)::int as n from public.v_pending_executions where age_days > 3 and (${mine} = false or advisor_id = ${a.id})`)[0]?.n ?? 0),
    sip: (await tx<{ target: number; started: number }[]>`
      select coalesce(sum(sip_monthly_target), 0)::float8 as target, coalesce(sum(sip_monthly_started), 0)::float8 as started from public.v_client_sip`)[0],
    followUps: await listDueFollowUps(tx, 5),
  }));

  const sum = (f: (c: (typeof all)[number]) => number) => all.reduce((s, c) => s + f(c), 0);
  const awaiting = all.filter((c) => c.pending_total >= 0.5);
  const toCheck = all.filter((c) => c.cas_to_review > 0);
  const unadvised = all.filter((c) => c.unadvised_to_review > 0);
  const nextTranche = all.filter((c) => c.active_plan_id && c.pending_total < 0.5 && c.remaining_to_advise >= 0.5).sort((a, b) => b.remaining_to_advise - a.remaining_to_advise);
  const drafts = all.filter((c) => c.has_draft_plan);
  const noAgreement = all.filter((c) => c.agreement_status !== "VALID");
  const premiumGap = all.filter((c) => c.premium_status !== "ACTIVE" || c.renewal_due);
  const monthStart = `${day.slice(0, 7)}-01`;
  const byAdvisor = new Map<string, { n: number; v: number }>();
  for (const c of all) {
    const k = c.advisor_name ?? "Unassigned";
    const x = byAdvisor.get(k) ?? { n: 0, v: 0 };
    byAdvisor.set(k, { n: x.n + 1, v: x.v + (c.live_portfolio_value ?? 0) });
  }
  const items = (awaiting.length ? 1 : 0) + toCheck.length + unadvised.length + nextTranche.length + drafts.length + followUps.length;
  const maxDay = Math.max(1, ...week.map((w) => Math.max(w.advised, w.executed)));
  const canAdvise = actor.role !== "OPERATIONS";

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-brand-600">{formatDate(day)}</div>
          <h1 className="text-2xl font-semibold tracking-tight">{greeting()}, {actor.fullName.split(" ")[0] || "there"}</h1>
          <p className="mt-0.5 text-sm text-muted">{items ? `${items} thing(s) need you. Work the review list top to bottom.` : "Nothing waiting for you right now."}</p>
        </div>
        <div className="flex items-center gap-2">
          {actor.role !== "ADVISOR" ? (
            <div className="flex rounded-md border border-border bg-white p-0.5 text-xs">
              <Link href="/" className={cn("rounded px-2.5 py-1", !mine ? "bg-ink text-white" : "text-slate-600")}>All advisors</Link>
              <Link href="/?mine=1" className={cn("rounded px-2.5 py-1", mine ? "bg-ink text-white" : "text-slate-600")}>My clients</Link>
            </div>
          ) : null}
          {canAdvise ? (
            <DropMenu label="Issue call" primary align="right">
              <MenuItem href="/advice/new?side=SELL"><b className="text-red-700">Sell call</b></MenuItem>
              <MenuItem href="/advice/new?side=BUY"><b className="text-blue-700">Buy call</b></MenuItem>
              <MenuItem href="/advice/bulk" hint="Same call for several clients">Call many clients</MenuItem>
            </DropMenu>
          ) : <LinkButton href="/executions/pending">Record executions</LinkButton>}
        </div>
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-3">
        {/* Left: the book in numbers */}
        <aside aria-label="Your book" className="space-y-3">
          <section className="rounded-xl border border-border bg-surface p-4">
            <h2 className="text-sm font-semibold">{mine ? "Your clients" : "The book"}</h2>
            <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-4">
              <Stat label="Clients" value={all.length} hint={`+${all.filter((c) => c.onboarding_date >= monthStart).length} onboarded this month`} />
              <Stat label="Under advice" value={<Money value={sum((c) => c.live_portfolio_value ?? 0)} />} hint="units × today's NAV" />
              <Stat label="Active plans" value={all.filter((c) => c.active_plan_id).length} hint={`${drafts.length} draft(s) · ${all.filter((c) => !c.active_plan_id).length} without plan`} />
              <Stat label="Awaiting execution" value={<Money value={sum((c) => c.pending_total)} />} tone={awaiting.length ? "text-amber-700" : undefined} hint={`${awaiting.length} client(s)`} />
              <Stat label="Premium recorded" value={<Money value={sum((c) => c.premium_paid_total)} />} hint={<span className={premiumGap.length ? "text-red-700" : undefined}>{premiumGap.length} not active / renewal due</span>} />
              <Stat label="Agreements" value={`${all.length - noAgreement.length} / ${all.length}`} hint={<span className={noAgreement.length ? "text-red-700" : undefined}>{noAgreement.length} missing or expired</span>} />
            </div>
            {byAdvisor.size > 1 || !mine ? (
              <div className="mt-4">
                <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-muted">Clients by advisor</div>
                <ul className="mt-1 space-y-0.5 text-xs">
                  {[...byAdvisor.entries()].sort((a, b) => b[1].v - a[1].v).map(([k, x]) => (
                    <li key={k} className="flex justify-between"><span>{k}</span><span className="num">{x.n} · {formatINRCompact(x.v)}</span></li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>

          <section className="space-y-2.5 rounded-xl border border-border bg-surface p-4">
            <h2 className="text-sm font-semibold">Rebalancing across all plans</h2>
            <Bar label="Sell" color="text-red-700" done={sum((c) => c.executed_sell)} target={sum((c) => c.target_sell)} />
            <Bar label="Buy" color="text-blue-700" done={sum((c) => c.executed_buy)} target={sum((c) => c.target_buy)} />
            <Bar label="SIP / month" color="text-violet-700" done={sip.started} target={sip.target} />
          </section>

          <section className="rounded-xl border border-border bg-surface p-4">
            <div className="flex items-baseline justify-between"><h2 className="text-sm font-semibold">Last 7 days</h2><span className="text-[11px] text-muted">advised vs executed</span></div>
            <div className="mt-3 flex h-24 items-end gap-2" role="img" aria-label="Amount advised and executed per day over the last 7 days">
              {week.map((w) => (
                <div key={w.d} className="flex h-full flex-1 items-end gap-0.5" title={`${formatDate(w.d)}: advised ${formatINRCompact(w.advised)}, executed ${formatINRCompact(w.executed)}`}>
                  <div className="flex-1 rounded-t bg-blue-300" style={{ height: `${(w.advised / maxDay) * 100}%` }} />
                  <div className="flex-1 rounded-t bg-emerald-500" style={{ height: `${(w.executed / maxDay) * 100}%` }} />
                </div>
              ))}
            </div>
            <div className="mt-1 flex gap-2 text-[10px] text-muted">{week.map((w) => <span key={w.d} className="flex-1 text-center">{w.d === day ? "Today" : new Intl.DateTimeFormat("en-IN", { weekday: "short", timeZone: "UTC" }).format(new Date(`${w.d}T00:00:00Z`))}</span>)}</div>
            <div className="mt-2 flex gap-3 text-[11px] text-muted">
              <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-blue-300" />Advised {formatINRCompact(week.reduce((s, w) => s + w.advised, 0))}</span>
              <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-emerald-500" />Executed {formatINRCompact(week.reduce((s, w) => s + w.executed, 0))}</span>
            </div>
          </section>

          <section className="rounded-xl border border-border bg-surface p-4">
            <h2 className="text-sm font-semibold">Latest activity</h2>
            {recent.length ? (
              <ul className="mt-2 space-y-1.5 text-xs">
                {recent.map((r, i) => (
                  <li key={i}><span className="text-muted">{formatDate(r.at)} · {r.kind}</span> · <Link href={`/clients/${r.client_id}`} className="font-medium hover:underline">{r.client_name}</Link> · {r.text}</li>
                ))}
              </ul>
            ) : <p className="mt-2 text-xs text-muted">Nothing yet.</p>}
          </section>
        </aside>

        {/* Right: review queue */}
        <section aria-label="Review" className="space-y-3 xl:col-span-2">
          <div className="flex items-baseline justify-between"><h2 className="text-[15px] font-semibold">Review · {items} item(s)</h2><span className="text-xs text-muted">oldest first within each group</span></div>

          {awaiting.length ? (
            <Queue n={openCalls} tone="bg-amber-100 text-amber-900" title="Record executions"
              sub={<>Calls advised, not yet executed · <Money value={sum((c) => c.pending_total)} /> · {stale} older than 3 days</>}
              href="/executions/pending" linkLabel="Open all">
              <ul className="divide-y divide-border text-[13px]">
                {calls.map((c) => (
                  <li key={c.advice_item_id} className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,2fr)_90px_80px_64px] items-center gap-2 px-4 py-2">
                    <Link href={`/clients/${c.client_id}`} className="truncate font-medium hover:underline">{c.client_name} <span className="text-xs font-normal text-muted">{c.client_code}</span></Link>
                    <span className="truncate"><ActionBadge action={c.action} /> {c.scheme_name}</span>
                    <span className="text-right font-semibold"><Money value={c.pending_amount} /></span>
                    <span className={cn("text-xs", c.age_days > 3 ? "font-semibold text-red-700" : "text-muted")}>{c.age_days} day(s)</span>
                    <Link href={`/executions/pending?client=${c.client_id}`} className="text-right text-xs font-medium text-brand hover:underline">Record</Link>
                  </li>
                ))}
              </ul>
            </Queue>
          ) : null}

          {toCheck.length || unadvised.length ? (
            <Queue n={toCheck.length + unadvised.length} tone="bg-red-100 text-red-800" title={PAGES.casInbox}
              sub={<>{toCheck.length} CAS waiting for your check · {unadvised.length} client(s) with trades done without advice</>}
              href="/reconciliation" linkLabel="Open inbox" />
          ) : null}

          {nextTranche.length ? (
            <Queue n={nextTranche.length} tone="bg-brand-50 text-brand-700" title="Next tranche to advise"
              sub={<>Last tranche done; the plan still has money to move · <Money value={nextTranche.reduce((s, c) => s + c.remaining_to_advise, 0)} /></>}
              href="/clients?attention=tranche" linkLabel={`See all ${nextTranche.length}`}>
              <ul className="divide-y divide-border text-[13px]">
                {nextTranche.slice(0, 4).map((c) => (
                  <li key={c.client_id} className="grid grid-cols-[minmax(0,1.4fr)_90px_1fr_1fr_80px] items-center gap-2 px-4 py-2">
                    <Link href={`/clients/${c.client_id}?tab=tranches`} className="truncate font-medium hover:underline">{c.full_name}</Link>
                    <span className="text-xs text-muted">Tranche {Math.max(1, c.cas_count)}</span>
                    <span className="text-xs">Sell <Money value={c.yet_to_advise_sell} /></span>
                    <span className="text-xs">Buy <Money value={c.yet_to_advise_buy} /></span>
                    {canAdvise ? <Link href={`/advice/new?client=${c.client_id}`} className="text-right text-xs font-medium text-brand hover:underline">Issue calls</Link> : <span />}
                  </li>
                ))}
              </ul>
            </Queue>
          ) : null}

          <div className="grid gap-3 md:grid-cols-3">
            <Link href="/clients?plan=draft" className="rounded-xl border border-border bg-surface p-4 hover:border-brand-200">
              <div className="flex justify-between"><b>Plans to approve</b><span className="font-bold text-brand">{drafts.length}</span></div>
              <div className="mt-1 text-xs text-muted">{drafts.length ? drafts.slice(0, 2).map((c) => c.full_name).join(", ") + (drafts.length > 2 ? "…" : "") : "No drafts waiting"}</div>
            </Link>
            <Link href="/clients?attention=follow_up" className="rounded-xl border border-border bg-surface p-4 hover:border-brand-200">
              <div className="flex justify-between"><b>Follow-ups due</b><span className={cn("font-bold", followUps.length ? "text-amber-700" : "text-muted")}>{followUps.length}</span></div>
              <div className="mt-1 text-xs text-muted">{followUps.length ? followUps.slice(0, 2).map((n) => n.client_name).join(", ") : "None due"}</div>
            </Link>
            <Link href="/clients?agreement=missing" className="rounded-xl border border-border bg-surface p-4 hover:border-brand-200">
              <div className="flex justify-between"><b>Premium &amp; agreements</b><span className={cn("font-bold", noAgreement.length || premiumGap.length ? "text-red-700" : "text-muted")}>{Math.max(noAgreement.length, premiumGap.length)}</span></div>
              <div className="mt-1 text-xs text-muted">{noAgreement.length} without agreement · {all.filter((c) => c.renewal_due).length} renewal(s) due</div>
            </Link>
          </div>

          {!items ? <p className="rounded-xl border border-dashed border-border bg-white p-6 text-center text-sm text-muted">All clear. New CAS files go in the <Link className="text-brand hover:underline" href="/reconciliation">CAS inbox</Link>.</p> : null}
        </section>
      </div>
    </>
  );
}
