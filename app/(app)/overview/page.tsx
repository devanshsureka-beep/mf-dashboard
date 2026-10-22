import Link from "next/link";
import { AutoSelect } from "@/components/app/auto-select";
import { BookView, ALLOCS, type Alloc } from "@/components/app/book-view";
import { PAGES } from "@/lib/brand";
import { GROUP_BYS, type GroupBy } from "@/lib/domain/book";
import { PERIODS, PROOF_LABEL, periodOf, periodRange, type Proof } from "@/lib/domain/overview";
import { formatINRCompact, todayIST } from "@/lib/format";
import { pageData } from "@/lib/server";
import { cn, UUID_RE } from "@/lib/utils";
import { getBookHoldings, getBookTrend } from "@/services/book";
import { getOverview, listOverviewAdvisors, type BookRow, type MonthRow } from "@/services/overview";
import { listDeskClients } from "@/services/clients";

export const metadata = { title: PAGES.overview };

const L = (v: number) => formatINRCompact(v);
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (m: string) => `${MON[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const dayLabel = (d: string) => `${d.slice(8, 10)}-${MON[Number(d.slice(5, 7)) - 1]}`;
const SORTS = [{ key: "behind", label: "Behind first" }, { key: "pending", label: "Most pending" }, { key: "idle", label: "Most idle cash" }, { key: "name", label: "Name" }] as const;
const PROOF_TONE: Record<Proof, string> = {
  CAS: "border-emerald-600 text-emerald-700", APPROVED: "border-blue-600 text-blue-700", PRE: "border-slate-400 text-slate-600", OFF: "border-red-600 text-red-700",
};
const STATUS_TONE: Record<BookRow["status"]["tone"], string> = {
  red: "bg-red-50 text-red-700", amber: "bg-amber-50 text-amber-800", orange: "bg-orange-50 text-orange-800",
  indigo: "bg-indigo-50 text-indigo-700", green: "bg-emerald-50 text-emerald-700", grey: "bg-slate-100 text-slate-600",
};

function Kpi({ label, value, sub, tone, warn }: { label: string; value: React.ReactNode; sub: React.ReactNode; tone?: string; warn?: boolean }) {
  return (
    <div className={cn("min-w-0 rounded-xl border border-border px-4 py-3", warn ? "bg-amber-50/60" : "bg-surface")}>
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted">{label}</div>
      <div className={cn("mt-0.5 text-2xl font-bold tracking-tight num", tone)}>{value}</div>
      <div className="text-xs text-muted">{sub}</div>
    </div>
  );
}

/** Sell vs buy executed by month: two bars per month, oldest on the left. */
function MonthBars({ months }: { months: MonthRow[] }) {
  const rows = [...months].reverse();
  const max = Math.max(1, ...rows.map((m) => Math.max(m.sell, m.buy)));
  if (!rows.some((m) => m.sell || m.buy)) return <p className="py-10 text-center text-sm text-muted">No trades in this period.</p>;
  return (
    <div>
      <div className="mb-2 flex gap-4 text-[11px] text-muted"><span><i className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-[#0f2a4a]" />Sell</span><span><i className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-[#0e9f9a]" />Buy</span></div>
      <div className="flex h-48 items-end gap-3 border-b border-border">
        {rows.map((m) => (
          <div key={m.month} className="flex min-w-0 flex-1 items-end justify-center gap-1" title={`${monthLabel(m.month)} · Sell ${L(m.sell)} (${m.sell_clients} clients) · Buy ${L(m.buy)} (${m.buy_clients} clients)`}>
            {[["sell", m.sell, "bg-[#0f2a4a]"], ["buy", m.buy, "bg-[#0e9f9a]"]].map(([k, v, c]) => (
              <div key={k as string} className="flex w-full max-w-8 flex-col items-center justify-end">
                {Number(v) > 0 ? <span className="mb-0.5 text-[10px] text-slate-600 num">{L(Number(v))}</span> : null}
                <div className={cn("w-full rounded-t", c as string)} style={{ height: `${Math.max(Number(v) > 0 ? 2 : 0, (Number(v) / max) * 150)}px` }} />
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-3">{rows.map((m) => <span key={m.month} className="flex-1 text-center text-[11px] text-muted">{monthLabel(m.month)}</span>)}</div>
    </div>
  );
}

export default async function OverviewPage(props: PageProps<"/overview">) {
  const sp = await props.searchParams;
  const s = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const view = s("view") === "book" ? "book" : "execution";
  const period = periodOf(s("period")).key;
  const alloc: Alloc = ALLOCS.some((a) => a.key === s("alloc")) ? (s("alloc") as Alloc) : "class";
  const by: GroupBy = GROUP_BYS.some((g) => g.key === s("by")) ? (s("by") as GroupBy) : "category";
  const sort = SORTS.some((x) => x.key === s("sort")) ? s("sort") : "behind";
  const q = s("q").trim().toLowerCase();
  const txClient = UUID_RE.test(s("tc")) ? s("tc") : "";
  const txSide = s("side") === "SELL" || s("side") === "BUY" ? s("side") : "";
  const txProof = (["CAS", "APPROVED", "PRE", "OFF"] as const).find((p) => p === s("proof")) ?? "";
  const txMonth = /^\d{4}-\d{2}$/.test(s("tm")) ? s("tm") : "";
  const range = periodRange(period, todayIST());

  const data = await pageData(async (tx, actor) => {
    // An advisor sees their own clients; admins and operations pick an advisor or see everyone.
    const advisorId = actor.role === "ADVISOR" ? actor.id : UUID_RE.test(s("advisor")) ? s("advisor") : null;
    const advisors = actor.role === "ADVISOR" ? [] : await listOverviewAdvisors(tx);
    if (view === "book") {
      const live = (await listDeskClients(tx, advisorId ? { advisorId } : {}));
      return {
        advisorId, advisors, overview: null,
        holdings: await getBookHoldings(tx, advisorId),
        trend: await getBookTrend(tx, advisorId, live.reduce((t, c) => t + (c.live_portfolio_value ?? 0), 0), live.filter((c) => (c.live_portfolio_value ?? 0) > 0).length),
      };
    }
    return { advisorId, advisors, overview: await getOverview(tx, { advisorId, ...range }), holdings: [], trend: [] };
  });
  const { actor, advisorId, advisors, overview: o } = data;

  /** This page's link with some settings changed (kept: view, period, advisor and the view's own settings). */
  const href = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams();
    const cur: Record<string, string> = { view: view === "book" ? "book" : "", period: period === "month" ? "" : period, advisor: actor.role === "ADVISOR" ? "" : advisorId ?? "",
      alloc: alloc === "class" ? "" : alloc, by: by === "category" ? "" : by, sort: sort === "behind" ? "" : sort, q, tc: txClient, side: txSide, proof: txProof, tm: txMonth };
    for (const [k, v] of Object.entries({ ...cur, ...patch })) if (v) p.set(k, v);
    const qs = p.toString();
    return `/overview${qs ? `?${qs}` : ""}`;
  };
  const exportHref = `/overview/export?${new URLSearchParams({ view, period, ...(advisorId && actor.role !== "ADVISOR" ? { advisor: advisorId } : {}) }).toString()}`;

  const header = (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-brand-600">Overview</div>
        <h1 className="text-2xl font-semibold tracking-tight">{view === "book" ? "How big is the book, and where is it" : "How the book is doing"}</h1>
        {o ? (
          <p className="mt-0.5 max-w-3xl text-sm text-slate-600">
            <b className="text-ink">{L(o.kpis.idle.amount)}</b> is sitting idle in {o.kpis.idle.clients} client{o.kpis.idle.clients === 1 ? "" : "s"}&rsquo; bank — sold but not reinvested — with{" "}
            <b className="text-ink">{L(o.kpis.buy.waiting + o.kpis.buy.notAdvised)}</b> of buys and <b className="text-ink">{L(o.kpis.sell.waiting + o.kpis.sell.notAdvised)}</b> of sells still to happen.
          </p>
        ) : <p className="mt-0.5 text-sm text-slate-600">Money in funds over time, where it sits, and the book by category, AMC, advisor or client.</p>}
      </div>
      <form action="/overview" className="flex flex-wrap items-center gap-2 text-sm">
        <span className="flex overflow-hidden rounded-md border border-border bg-white text-[13px] font-semibold">
          <Link href={href({ view: null })} className={cn("px-3.5 py-1.5", view === "execution" ? "bg-ink text-white" : "text-slate-700 hover:bg-slate-50")}>Execution</Link>
          <Link href={href({ view: "book" })} className={cn("px-3.5 py-1.5", view === "book" ? "bg-ink text-white" : "text-slate-700 hover:bg-slate-50")}>Book</Link>
        </span>
        {view === "book" ? <input type="hidden" name="view" value="book" /> : null}
        {view === "execution" ? (
          <AutoSelect name="period" defaultValue={period} aria-label="Period" className="h-8 w-auto text-[13px]">
            {PERIODS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </AutoSelect>
        ) : <input type="hidden" name="period" value={period} />}
        {actor.role !== "ADVISOR" ? (
          <AutoSelect name="advisor" defaultValue={advisorId ?? ""} aria-label="Advisor" className="h-8 w-auto text-[13px]">
            <option value="">All advisors</option>
            {advisors.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </AutoSelect>
        ) : null}
        <a href={exportHref} className="rounded-md border border-border bg-white px-3 py-1.5 text-[13px] font-semibold hover:bg-slate-50">Export CSV</a>
      </form>
    </div>
  );

  if (!o) {
    return (
      <>
        {header}
        <BookView trend={data.trend} holdings={data.holdings} alloc={alloc} by={by} canAdvise={actor.role !== "OPERATIONS"} href={(patch) => href({ view: "book", ...patch })} />
      </>
    );
  }

  const k = o.kpis;
  const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");
  const rank = (r: BookRow) => r.status.rank;
  const book = o.book
    .filter((r) => !q || r.name.toLowerCase().includes(q) || r.code.toLowerCase().includes(q))
    .sort((a, b) => sort === "name" ? a.name.localeCompare(b.name)
      : sort === "idle" ? b.idle - a.idle
      : sort === "pending" ? (b.sell_pending + b.buy_pending) - (a.sell_pending + a.buy_pending)
      : rank(a) - rank(b) || (b.sell_pending + b.buy_pending) - (a.sell_pending + a.buy_pending));
  const txns = o.txns.filter((t) => (!txClient || t.client_id === txClient) && (!txSide || t.side === txSide) && (!txProof || t.proof === txProof) && (!txMonth || t.date.startsWith(txMonth)));
  const shownTx = txns.slice(0, 200);
  const totals = o.months.reduce((t, m) => ({ reports: t.reports + m.reports, cas: t.cas + m.cas_checks, ag: t.ag + m.agreements, sell: t.sell + m.sell, buy: t.buy + m.buy }), { reports: 0, cas: 0, ag: 0, sell: 0, buy: 0 });
  const txClients = [...new Map(o.txns.map((t) => [t.client_id, t.client])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const th = "px-3 py-2 text-[10.5px] font-semibold uppercase tracking-wide text-muted";

  return (
    <>
      {header}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <Kpi label="Clients" value={k.clients} sub={<>agreements signed <b className="text-ink">{k.agreementsSigned}</b> · {k.onPlan} on a plan</>} />
        <Kpi label="Sell executed" value={L(k.sell.executed)} tone="text-red-700" sub={<>of <b className="text-ink">{L(k.sell.target)}</b> advised · {pct(k.sell.executed, k.sell.target)}</>} />
        <Kpi warn label="Sell pending" value={L(k.sell.waiting + k.sell.notAdvised)} tone="text-amber-700" sub={<>{L(k.sell.waiting)} waiting · {L(k.sell.notAdvised)} not advised</>} />
        <Kpi label="Buy executed" value={L(k.buy.executed)} tone="text-blue-700" sub={<>of <b className="text-ink">{L(k.buy.target)}</b> advised · {pct(k.buy.executed, k.buy.target)}</>} />
        <Kpi warn label="Buy pending" value={L(k.buy.waiting + k.buy.notAdvised)} tone="text-amber-700" sub={<>{L(k.buy.waiting)} waiting · {L(k.buy.notAdvised)} not advised</>} />
        <Kpi warn label="Idle in bank" value={L(k.idle.amount)} tone="text-red-700" sub={<>sold + fresh − bought · {k.idle.clients} client{k.idle.clients === 1 ? "" : "s"}</>} />
        <Kpi warn label="SIP gap" value={<>{L(Math.max(0, k.sip.target - k.sip.running))}<span className="text-sm font-semibold">/mo</span></>} tone="text-amber-700" sub={<>of {L(k.sip.target)} advised, not running</>} />
      </div>
      <p className="mt-1.5 text-[11px] text-muted">Figures above are as of today on the active plans. Charts, activity and trades below cover {periodOf(period).label.toLowerCase()} ({dayLabel(range.from)} – {dayLabel(range.to)}).</p>

      <div className="mt-4 grid items-start gap-4 xl:grid-cols-2">
        <section className="rounded-xl border border-border bg-surface p-4">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-[15px] font-semibold">Sell vs buy executed, by month</h2><span className="text-xs text-muted">rupees that moved: CAS-verified + approved</span></div>
          <MonthBars months={o.months} />
        </section>
        <section className="overflow-hidden rounded-xl border border-border bg-surface">
          <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-4 pb-2"><h2 className="text-[15px] font-semibold">Monthly activity</h2><span className="text-xs text-muted">reports, CAS checks and agreements, and money moved</span></div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-[13px]">
              <thead className="border-y border-border bg-slate-50 text-right"><tr><th className={cn(th, "text-left")}>Month</th><th className={th}>Reports</th><th className={th}>CAS checks</th><th className={th}>Agreements</th><th className={th}>Sell clients</th><th className={th}>Sell ₹</th><th className={th}>Buy clients</th><th className={th}>Buy ₹</th></tr></thead>
              <tbody className="divide-y divide-border text-right num">
                {o.months.map((m) => (
                  <tr key={m.month}><td className="px-3 py-2 text-left">{monthLabel(m.month)}</td><td className="px-3 py-2">{m.reports}</td><td className="px-3 py-2">{m.cas_checks}</td><td className="px-3 py-2">{m.agreements}</td>
                    <td className="px-3 py-2">{m.sell_clients}</td><td className="px-3 py-2">{L(m.sell)}</td><td className="px-3 py-2">{m.buy_clients}</td><td className="px-3 py-2">{L(m.buy)}</td></tr>
                ))}
                {o.months.length > 1 ? <tr className="bg-slate-50 font-semibold"><td className="px-3 py-2 text-left">Total</td><td className="px-3 py-2">{totals.reports}</td><td className="px-3 py-2">{totals.cas}</td><td className="px-3 py-2">{totals.ag}</td><td className="px-3 py-2" /><td className="px-3 py-2">{L(totals.sell)}</td><td className="px-3 py-2" /><td className="px-3 py-2">{L(totals.buy)}</td></tr> : null}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section id="book" className="mt-4 overflow-hidden rounded-xl border border-border bg-surface">
        <form action="/overview" className="flex flex-wrap items-center gap-2 px-4 py-3">
          <h2 className="text-[15px] font-semibold">Client book</h2>
          <span className="flex-1 text-xs text-muted">advised vs executed per client, and what&rsquo;s still to happen</span>
          {Object.entries({ period: period === "month" ? "" : period, advisor: actor.role === "ADVISOR" ? "" : advisorId ?? "", tc: txClient, side: txSide, proof: txProof, tm: txMonth }).filter(([, v]) => v).map(([n, v]) => <input key={n} type="hidden" name={n} value={v} />)}
          <input name="q" defaultValue={q} placeholder="Search client" aria-label="Search client" className="h-8 w-44 rounded-md border border-border bg-white px-2.5 text-[13px]" />
          <AutoSelect name="sort" defaultValue={sort} aria-label="Sort" className="h-8 w-auto text-[13px]">
            {SORTS.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
          </AutoSelect>
        </form>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1080px] text-[13px]">
            <thead className="border-y border-border bg-slate-50 text-right"><tr>
              <th className={cn(th, "text-left")}>Client</th><th className={cn(th, "text-left")}>Advisor</th><th className={cn(th, "text-left")}>Status</th>
              <th className={th}>Sold</th><th className={th}>Sell pending</th><th className={th}>Bought</th><th className={th}>Buy pending</th><th className={th}>Idle in bank</th><th className={th}>SIP gap /mo</th><th className={cn(th, "text-left")}>Next action</th>
            </tr></thead>
            <tbody className="divide-y divide-border">
              {book.map((r) => (
                <tr key={r.client_id} className="hover:bg-slate-50">
                  <td className="px-3 py-2"><Link href={`/clients/${r.client_id}`} className="font-semibold hover:underline">{r.name}</Link></td>
                  <td className="px-3 py-2 text-slate-600">{r.advisor?.split(" ")[0] ?? "—"}</td>
                  <td className="px-3 py-2"><span className={cn("whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-semibold", STATUS_TONE[r.status.tone])}>{r.status.label}</span></td>
                  <td className="px-3 py-2 text-right num">{r.sold >= 0.5 ? L(r.sold) : "—"}</td>
                  <td className="px-3 py-2 text-right text-amber-700 num">{r.sell_pending >= 0.5 ? L(r.sell_pending) : "—"}</td>
                  <td className="px-3 py-2 text-right num">{r.bought >= 0.5 ? L(r.bought) : "—"}</td>
                  <td className="px-3 py-2 text-right text-amber-700 num">{r.buy_pending >= 0.5 ? L(r.buy_pending) : "—"}</td>
                  <td className="px-3 py-2 text-right text-red-700 num">{r.idle >= 0.5 ? L(r.idle) : "—"}</td>
                  <td className="px-3 py-2 text-right text-amber-700 num">{r.sip_gap >= 0.5 ? L(r.sip_gap) : "—"}</td>
                  <td className="px-3 py-2 text-slate-700">{r.next}</td>
                </tr>
              ))}
              {!book.length ? <tr><td colSpan={10} className="px-3 py-4 text-sm text-muted">No clients match.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>

      <section id="trades" className="mt-4 overflow-hidden rounded-xl border border-border bg-surface">
        <form action="/overview#trades" className="flex flex-wrap items-center gap-2 px-4 py-3">
          <h2 className="text-[15px] font-semibold">Transaction log</h2>
          <span className="flex-1 text-xs text-muted">every rupee that moved in the period, with its proof</span>
          {Object.entries({ period: period === "month" ? "" : period, advisor: actor.role === "ADVISOR" ? "" : advisorId ?? "", q, sort: sort === "behind" ? "" : sort }).filter(([, v]) => v).map(([n, v]) => <input key={n} type="hidden" name={n} value={v} />)}
          <AutoSelect name="tc" defaultValue={txClient} aria-label="Client" className="h-8 w-auto text-[13px]">
            <option value="">All clients</option>{txClients.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </AutoSelect>
          <AutoSelect name="tm" defaultValue={txMonth} aria-label="Month" className="h-8 w-auto text-[13px]">
            <option value="">All months</option>{o.months.map((m) => <option key={m.month} value={m.month}>{monthLabel(m.month)}</option>)}
          </AutoSelect>
          <AutoSelect name="side" defaultValue={txSide} aria-label="Side" className="h-8 w-auto text-[13px]">
            <option value="">All sides</option><option value="SELL">Sell</option><option value="BUY">Buy</option>
          </AutoSelect>
          <AutoSelect name="proof" defaultValue={txProof} aria-label="Proof" className="h-8 w-auto text-[13px]">
            <option value="">All proof</option>{(Object.keys(PROOF_LABEL) as Proof[]).map((p) => <option key={p} value={p}>{PROOF_LABEL[p]}</option>)}
          </AutoSelect>
          <a href={`${exportHref}&what=trades`} className="rounded-md border border-border bg-white px-3 py-1.5 text-[13px] font-semibold hover:bg-slate-50">Export trades</a>
        </form>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-[13px]">
            <thead className="border-y border-border bg-slate-50"><tr>
              <th className={cn(th, "text-left")}>Date</th><th className={cn(th, "text-left")}>Client</th><th className={cn(th, "text-left")}>Side</th><th className={cn(th, "text-left")}>Fund</th>
              <th className={cn(th, "text-right")}>Amount</th><th className={cn(th, "text-left")}>Proof</th><th className={cn(th, "text-left")}>Call</th>
            </tr></thead>
            <tbody className="divide-y divide-border">
              {shownTx.map((t, i) => (
                <tr key={`${t.date}${t.client_id}${i}`}>
                  <td className="whitespace-nowrap px-3 py-2">{dayLabel(t.date)}</td>
                  <td className="px-3 py-2"><Link href={`/clients/${t.client_id}`} className="hover:underline">{t.client}</Link></td>
                  <td className={cn("px-3 py-2 font-semibold", t.side === "SELL" ? "text-red-700" : "text-blue-700")}>{t.side === "SELL" ? "Sell" : "Buy"}</td>
                  <td className="max-w-[360px] truncate px-3 py-2" title={t.fund}>{t.fund}</td>
                  <td className="px-3 py-2 text-right num">{L(t.amount)}</td>
                  <td className="px-3 py-2"><span className={cn("whitespace-nowrap rounded-full border px-2 py-px text-[11px]", PROOF_TONE[t.proof])}>{PROOF_LABEL[t.proof]}</span></td>
                  <td className="px-3 py-2 text-slate-600">{t.call ?? "—"}</td>
                </tr>
              ))}
              {!shownTx.length ? <tr><td colSpan={7} className="px-3 py-4 text-sm text-muted">No trades match.</td></tr> : null}
            </tbody>
          </table>
        </div>
        <p className="border-t border-border px-4 py-2 text-xs text-muted">
          {txns.length > shownTx.length ? `Showing the latest ${shownTx.length} of ${txns.length} (Export CSV has all). ` : ""}
          Proof: CAS verified = matched to a CAS transaction · Approved = the desk approved it, the next CAS confirms it · Before onboarding = done on the report before onboarding, the CAS is the proof · Off-plan = the client traded on their own.
        </p>
      </section>
    </>
  );
}
