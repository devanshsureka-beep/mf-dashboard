import Link from "next/link";
import { LinkButton } from "@/components/ui/button";
import { Money } from "@/components/app/money";
import { DropMenu, MenuItem } from "@/components/app/drop-menu";
import { PAGES } from "@/lib/brand";
import { formatDate, formatINRCompact } from "@/lib/format";
import { pageData } from "@/lib/server";
import { cn } from "@/lib/utils";
import { insights } from "@/lib/domain/book";
import { listDeskClients } from "@/services/clients";
import { ActiveDot } from "@/components/app/active-dot";
import { listDraftPlans } from "@/services/plans";
import { getBookHoldings, primaryAdvisor } from "@/services/book";
import { listWaiting } from "@/services/waiting";
import { listApprovedMissing } from "@/services/cas-inbox";
import { askCasHref } from "@/lib/ask-cas";

export const metadata = { title: PAGES.today };

function greeting(now = new Date()): string {
  const hour = Number(new Intl.DateTimeFormat("en-IN", { hour: "numeric", hourCycle: "h23", timeZone: "Asia/Kolkata" }).format(now));
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}

const todayIst = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const L = (v: number) => formatINRCompact(v);
const SHOW = 5;

type Row = { key: string; name: string; clientId: string; what: React.ReactNode; when: React.ReactNode; cta: React.ReactNode };
const TONES = {
  amber: { pin: "bg-amber-600", ring: "ring-amber-300", tile: "border-amber-300 text-amber-700" },
  green: { pin: "bg-emerald-700", ring: "ring-emerald-200", tile: "border-emerald-300 text-emerald-700" },
  red: { pin: "bg-red-600", ring: "ring-red-200", tile: "border-red-200 text-red-700" },
  brand: { pin: "bg-brand", ring: "ring-border", tile: "border-brand-200 text-brand-700" },
  grey: { pin: "bg-slate-600", ring: "ring-border", tile: "border-border text-slate-700" },
} as const;

/** One kind of work: what it is, one button for all of it, and every client with their own button. */
function Work({ id, n, tone, title, sub, href, cta, rows, more, act }: {
  id: string; n: number; tone: keyof typeof TONES; title: string; sub: React.ReactNode; href: string; cta: string; rows: Row[]; more: number;
  act: Map<string, { is_active: boolean; first_advised_at: string | null }>;
}) {
  return (
    <section id={id} className={cn("scroll-mt-14 overflow-hidden rounded-xl bg-surface ring-1", TONES[tone].ring)}>
      <div className="flex items-center gap-3 px-4 py-3">
        <span className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-full text-[13px] font-bold text-white", TONES[tone].pin)}>{n}</span>
        <div className="min-w-0 flex-1"><b className="text-[15px]">{title}</b><div className="truncate text-[12.5px] text-muted">{sub}</div></div>
        <Link href={href} className="shrink-0 rounded-md border border-border bg-white px-3 py-1.5 text-[13px] font-semibold hover:bg-slate-50">{cta}</Link>
      </div>
      {rows.length ? (
        <ul className="divide-y divide-slate-100 border-t border-slate-100 text-[13px]">
          {rows.map((r) => (
            <li key={r.key} className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1.7fr)_minmax(0,0.9fr)_auto] items-center gap-3 py-2 pl-14 pr-4">
              <Link href={`/clients/${r.clientId}`} className="truncate font-semibold hover:underline"><ActiveDot active={act.get(r.clientId)?.is_active} since={act.get(r.clientId)?.first_advised_at} />{r.name}</Link>
              <span className="truncate text-slate-600">{r.what}</span>
              <span className="truncate text-xs text-muted">{r.when}</span>
              <span className="text-right text-[12.5px] font-semibold text-brand">{r.cta}</span>
            </li>
          ))}
          {more > 0 ? <li className="py-2 pl-14 pr-4 text-xs"><Link href={href} className="text-brand hover:underline">+ {more} more →</Link></li> : null}
        </ul>
      ) : null}
    </section>
  );
}

/**
 * Today: only the work, in the order to do it. Every client is listed with one button.
 * The book numbers (executed vs advised, idle cash, monthly activity, the book) are on Overview.
 */
export default async function Today(props: PageProps<"/">) {
  const sp = await props.searchParams;
  const mine = sp.mine === "1";
  const day = todayIst();
  const { all, waiting, draftPlans, casConfirm, holdings, approvedMissing: missingAll, actor } = await pageData(async (tx, a) => {
    const adv = mine ? a.id : null;
    return {
      all: await listDeskClients(tx, mine ? { advisorId: a.id } : {}),
      waiting: await listWaiting(tx, { advisorId: adv }),
      draftPlans: await listDraftPlans(tx, { advisorId: adv }),
      // Calls a new CAS seems to show, waiting for one click (as the CAS inbox counts them).
      casConfirm: Number((await tx<{ n: number }[]>`
        select count(*)::int as n
        from public.reconciliation_matches m join public.reconciliation_runs r on r.id = m.run_id
        join public.clients c on c.id = m.client_id and c.deleted_at is null
        ${primaryAdvisor(tx)}
        where m.classification = 'ADVICE_MATCH' and m.status = 'SUGGESTED' and r.status <> 'CANCELLED'
          and exists (select 1 from public.advice_items ai where ai.id = m.advice_item_id and ai.status in ('ISSUED', 'PARTIALLY_EXECUTED', 'EXECUTED'))
          and (${adv}::uuid is null or adv.advisor_id = ${adv})`)[0]?.n ?? 0),
      holdings: await getBookHoldings(tx, adv),
      approvedMissing: await listApprovedMissing(tx),
    };
  });
  const adv = mine ? actor.id : null;
  /** A link that keeps "My clients" on the page it opens. */
  const withAdv = (u: string) => (adv ? `${u}${u.includes("?") ? "&" : "?"}advisor=${adv}` : u);
  const canAdvise = actor.role !== "OPERATIONS";
  const act = new Map(all.map((c) => [c.client_id, c]));
  const name = (id: string) => all.find((c) => c.client_id === id)?.full_name ?? "";

  // 1. CAS inbox (approved trades the latest CAS does not show are asked there too)
  const missing = new Map(missingAll.filter((m) => all.some((c) => c.client_id === m.client_id)).map((m) => [m.client_id, m.trades]));
  const casClients = all.filter((c) => c.cas_to_review > 0 || c.unadvised_to_review > 0 || missing.has(c.client_id));
  const casRows: Row[] = casClients.map((c) => ({
    key: c.client_id, clientId: c.client_id, name: c.full_name,
    what: [c.cas_to_review ? "new CAS to check" : null, c.unadvised_to_review ? `${c.unadvised_to_review} trade${c.unadvised_to_review === 1 ? "" : "s"} to decide` : null,
      missing.has(c.client_id) ? `${missing.get(c.client_id)} approved, not in the CAS` : null].filter(Boolean).join(" · "),
    when: c.pending_cas_date ? `CAS of ${formatDate(c.pending_cas_date)}` : "",
    cta: <Link href={`/reconciliation?c=${c.client_id}`} className="hover:underline">Open →</Link>,
  }));
  const casCount = casClients.length + casConfirm;

  // 2. Approve waiting (per client) and 3. Ask for a CAS (waiting 30+ days, no CAS since)
  const byClient = new Map<string, { calls: number; amount: number; oldest: number; casAfter: boolean; phone: string | null }>();
  for (const w of waiting) {
    const x = byClient.get(w.client_id) ?? { calls: 0, amount: 0, oldest: 0, casAfter: false, phone: w.phone };
    x.calls++;
    x.amount += Number(w.pending_amount);
    if (w.age_days >= x.oldest) { x.oldest = w.age_days; x.casAfter = Boolean(w.cas_after); }
    byClient.set(w.client_id, x);
  }
  const waitClients = [...byClient.entries()].sort((a, b) => b[1].oldest - a[1].oldest);
  const waitRows: Row[] = waitClients.map(([id, x]) => ({
    key: id, clientId: id, name: name(id) || waiting.find((w) => w.client_id === id)?.client_name || "",
    what: <>{x.calls} call{x.calls === 1 ? "" : "s"} · <Money value={x.amount} /></>,
    when: `oldest ${x.oldest} day${x.oldest === 1 ? "" : "s"}`,
    cta: canAdvise ? <Link href={`/clients/${id}/waiting`} className="hover:underline">Approve waiting · {x.calls} →</Link> : <Link href={`/clients/${id}?tab=tranches`} className="hover:underline">See →</Link>,
  }));
  const stale = waitClients.filter(([, x]) => x.oldest > 30 && !x.casAfter);
  const staleRows: Row[] = stale.map(([id, x]) => {
    const first = waiting.filter((w) => w.client_id === id).sort((a, b) => b.age_days - a.age_days)[0];
    return {
      key: id, clientId: id, name: first?.client_name ?? name(id),
      what: <>{first?.action === "BUY" ? "BUY" : "SELL"} {first?.scheme_name}</>,
      when: `${x.oldest} days`,
      cta: <a href={askCasHref({ client_id: id, full_name: first?.client_name ?? name(id), phone: x.phone })} target="_blank" rel="noreferrer" className="hover:underline">Ask for CAS →</a>,
    };
  });

  // 4. Drafts
  const draftRows: Row[] = draftPlans.map((d) => {
    const days = Math.max(0, Math.round((Date.parse(day) - new Date(d.created_at).getTime()) / 86400000));
    const q = d.open_questions + d.needs_review;
    return {
      key: d.plan_id, clientId: d.client_id, name: d.client_name,
      what: `report of ${formatDate(d.plan_date)} · ${q ? `${q} question${q === 1 ? "" : "s"}` : "ready"}`,
      when: `${days} day${days === 1 ? "" : "s"}`,
      cta: <Link href={`/clients/${d.client_id}/plans/${d.plan_id}`} className="hover:underline">{canAdvise ? (q ? "Review" : "Approve") : "See"} →</Link>,
    };
  });
  const draftQuestions = draftPlans.filter((d) => d.open_questions || d.needs_review).length;

  // 5. Next tranche
  const nextTranche = all.filter((c) => c.active_plan_id && c.pending_total < 0.5 && c.remaining_to_advise >= 0.5)
    .sort((a, b) => (b.last_call_days ?? 9999) - (a.last_call_days ?? 9999));
  const trancheRows: Row[] = nextTranche.map((c) => ({
    key: c.client_id, clientId: c.client_id, name: c.full_name,
    what: <>sell <Money value={c.yet_to_advise_sell} /> · buy <Money value={c.yet_to_advise_buy} /></>,
    when: c.last_call_days == null ? "no call yet" : `last call ${c.last_call_days} days`,
    cta: <Link href={canAdvise ? `/advice/new?client=${c.client_id}` : `/clients/${c.client_id}?tab=tranches`} className="hover:underline">{canAdvise ? "Advise" : "See"} →</Link>,
  }));

  // 6. Idle cash
  const idle = all.filter((c) => c.in_bank >= 0.5).sort((a, b) => b.in_bank - a.in_bank);
  const idleRows: Row[] = idle.map((c) => ({
    key: c.client_id, clientId: c.client_id, name: c.full_name,
    what: <><Money value={c.in_bank} /> in bank{c.yet_to_advise_buy >= 0.5 ? <> · plan buys <Money value={c.yet_to_advise_buy} /></> : null}</>,
    when: "",
    cta: <Link href={canAdvise ? `/advice/new?client=${c.client_id}&side=BUY` : `/clients/${c.client_id}`} className="hover:underline">{canAdvise ? "Advise buy" : "See"} →</Link>,
  }));

  // 7. Follow-ups
  const followUps = all.filter((c) => c.follow_ups_due > 0);
  const followRows: Row[] = followUps.map((c) => ({
    key: c.client_id, clientId: c.client_id, name: c.full_name,
    what: `${c.follow_ups_due} follow-up${c.follow_ups_due === 1 ? "" : "s"} due`, when: "",
    cta: <Link href={`/clients/${c.client_id}?tab=file#notes`} className="hover:underline">Open →</Link>,
  }));

  const items = [
    { id: "cas", n: casCount, tone: "amber" as const, title: PAGES.casInbox, tile: "CAS inbox", value: String(casCount), href: "/reconciliation", cta: "Open inbox", rows: casRows,
      sub: <>{all.filter((c) => c.cas_to_review).length} CAS to check · {casConfirm} call{casConfirm === 1 ? "" : "s"} the CAS seems to show · {all.filter((c) => c.unadvised_to_review).length} with trades to decide{missing.size ? ` · ${missing.size} with approved trades not in their CAS` : ""}</> },
    { id: "approve", n: waitClients.length, tone: "green" as const, title: "Approve waiting", tile: "Approve waiting", value: `${waiting.length} call${waiting.length === 1 ? "" : "s"}`, href: withAdv("/executions/pending"), cta: "Open list", rows: waitRows,
      sub: <>{waiting.length} call{waiting.length === 1 ? "" : "s"} · <Money value={waiting.reduce((t, w) => t + Number(w.pending_amount), 0)} /> advised, not in a CAS yet — mark what clients have done</> },
    { id: "ask", n: stale.length, tone: "red" as const, title: "Ask for a CAS", tile: "Waiting 30+ days", value: String(stale.length), href: withAdv("/executions/pending"), cta: "See all", rows: staleRows,
      sub: <>{stale.length} client{stale.length === 1 ? "" : "s"} with calls waiting 30+ days and no CAS since</> },
    ...(canAdvise ? [
      { id: "drafts", n: draftPlans.length, tone: "brand" as const, title: "Drafts to approve", tile: "Drafts to approve", value: String(draftPlans.length), href: withAdv("/clients?plan=draft"), cta: "Review", rows: draftRows,
        sub: <>{draftPlans.length} draft{draftPlans.length === 1 ? "" : "s"} · {draftPlans.length - draftQuestions} ready · {draftQuestions} with questions</> },
      { id: "tranche", n: nextTranche.length, tone: "brand" as const, title: "Next tranche to advise", tile: "Next tranche", value: `${nextTranche.length} · ${L(nextTranche.reduce((t, c) => t + c.remaining_to_advise, 0))}`, href: withAdv("/clients?attention=tranche"), cta: "Advise", rows: trancheRows,
        sub: <><Money value={nextTranche.reduce((t, c) => t + c.remaining_to_advise, 0)} /> left with {nextTranche.length} client{nextTranche.length === 1 ? "" : "s"} · {nextTranche.filter((c) => c.last_call_days == null || c.last_call_days > 30).length} with no call for 30+ days</> },
      { id: "idle", n: idle.length, tone: "amber" as const, title: "Idle cash to invest", tile: "Idle cash to invest", value: L(idle.reduce((t, c) => t + c.in_bank, 0)), href: withAdv("/advice/find?list=cash&waiting=show"), cta: "Find clients", rows: idleRows,
        sub: <><Money value={idle.reduce((t, c) => t + c.in_bank, 0)} /> sold and in bank with {idle.length} client{idle.length === 1 ? "" : "s"}</> },
    ] : []),
    { id: "follow", n: followUps.length, tone: "grey" as const, title: "Follow-ups due", tile: "Follow-ups due", value: String(followUps.reduce((t, c) => t + c.follow_ups_due, 0)), href: withAdv("/clients?attention=follow_up"), cta: "Open", rows: followRows,
      sub: followUps.slice(0, 3).map((c) => c.full_name).join(", ") },
  ];
  const open = items.filter((i) => i.n > 0);
  const clear = items.filter((i) => i.n === 0);
  const watch = insights(holdings, { inBank: idle.reduce((t, c) => t + c.in_bank, 0), inBankClients: idle.length, canAdvise, advisorId: adv })
    // Idle cash is already a work item above.
    .filter((w) => !/in bank/i.test(w.title));
  const noAgreement = all.filter((c) => c.agreement_status !== "VALID");
  const href = (m: boolean) => (m ? "/?mine=1" : "/");

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-brand-600">{formatDate(day)}</div>
          <h1 className="text-2xl font-semibold tracking-tight">{greeting()}, {actor.fullName.split(" ")[0] || "there"}</h1>
          <p className="mt-0.5 text-sm text-muted">{open.length ? `${open.length} kind${open.length === 1 ? "" : "s"} of work today, in the order to do them.${casCount ? " Start with the CAS: it decides what is left." : ""}` : "Nothing waiting for you right now."}</p>
        </div>
        <div className="flex items-center gap-2">
          {actor.role !== "ADVISOR" ? (
            <div className="flex rounded-md border border-border bg-white p-0.5 text-xs">
              <Link href={href(false)} className={cn("rounded px-2.5 py-1", !mine ? "bg-ink text-white" : "text-slate-600")}>All advisors</Link>
              <Link href={href(true)} className={cn("rounded px-2.5 py-1", mine ? "bg-ink text-white" : "text-slate-600")}>My clients</Link>
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

      <div className={cn("mb-4 grid grid-cols-2 gap-2 md:grid-cols-4", canAdvise ? "xl:grid-cols-7" : "xl:grid-cols-4")}>
        {items.map((i) => (
          <a key={i.id} href={i.n ? `#${i.id}` : i.href} className={cn("rounded-xl border bg-surface px-3 py-2.5 hover:shadow-sm", i.n ? TONES[i.tone].tile : "border-border text-slate-400")}>
            <div className="text-[11px] font-semibold text-muted">{i.tile}</div>
            <div className="text-xl font-bold num">{i.value}</div>
          </a>
        ))}
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_330px]">
        <div className="space-y-3">
          {open.map((i, idx) => (
            <Work key={i.id} id={i.id} n={idx + 1} tone={i.tone} title={i.title} sub={i.sub} href={i.href} cta={i.cta} rows={i.rows.slice(0, SHOW)} more={Math.max(0, i.rows.length - SHOW)} act={act} />
          ))}
          {!open.length ? <p className="rounded-xl border border-border bg-surface p-6 text-center text-sm text-muted">All clear. Nothing waiting for you right now.</p> : null}
          {clear.length && open.length ? <p className="px-1 text-xs text-emerald-700">All clear: {clear.map((i) => i.title.toLowerCase()).join(", ")}</p> : null}
        </div>

        <aside className="space-y-3">
          {watch.length ? (
            <section aria-label="Worth a look" className="rounded-xl border border-border bg-surface p-4">
              <div className="flex items-baseline justify-between"><h2 className="text-[15px] font-semibold">Worth a look</h2><span className="text-xs text-muted">from the funds clients hold</span></div>
              <ul className="mt-2 space-y-3">
                {watch.map((w) => (
                  <li key={w.title} className={cn("border-l-[3px] pl-2.5", w.tone === "review" ? "border-amber-500" : "border-brand")}>
                    <b className="text-[13px]">{w.title}</b>
                    <span className="block text-xs text-muted">{w.detail}</span>
                    {w.clients.length ? <span className="mt-0.5 flex flex-wrap gap-x-2 text-xs">{w.clients.map((c) => <Link key={c.id} href={`/clients/${c.id}`} className="text-brand hover:underline">{c.name}</Link>)}</span> : null}
                    {w.href ? <Link href={w.href} className="text-xs font-medium text-brand hover:underline">Open →</Link> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <section aria-label="Admin" className="rounded-xl border border-border bg-surface p-4 text-[13px]">
            <h2 className="text-[15px] font-semibold">Admin</h2>
            <ul className="mt-1.5 space-y-1 text-slate-600">
              <li><Link href={withAdv("/clients?agreement=missing")} className="hover:underline">{noAgreement.length} without an agreement</Link></li>
              <li><Link href={withAdv("/clients?premium=unpaid")} className="hover:underline">{all.filter((c) => c.premium_status === "UNPAID" || c.premium_status === "PAID").length} premium not recorded</Link></li>
              <li><Link href={withAdv("/clients?premium=renewal_due")} className="hover:underline">{all.filter((c) => c.renewal_due).length} renewal(s) due</Link> · <Link href={withAdv("/clients?premium=expired")} className="hover:underline">{all.filter((c) => c.premium_status === "EXPIRED").length} expired</Link></li>
            </ul>
          </section>
          <section aria-label="Book numbers" className="rounded-xl border border-border bg-surface p-4 text-[13px] text-slate-600">
            <h2 className="text-[15px] font-semibold text-ink">Book numbers?</h2>
            <p className="mt-1">Executed vs advised, pending, idle cash, SIP gap, monthly activity, the client book and every trade are on <b className="text-ink">{PAGES.overview}</b>.</p>
            <Link href={adv ? `/overview?advisor=${adv}` : "/overview"} className="mt-2 inline-block rounded-md border border-border bg-white px-3 py-1.5 font-semibold text-ink hover:bg-slate-50">Open {PAGES.overview} →</Link>
          </section>
        </aside>
      </div>
    </>
  );
}
