import Link from "next/link";
import { AllocationDonut } from "@/components/app/allocation-donut";
import { BookTrend } from "@/components/app/book-trend";
import { formatINRCompact } from "@/lib/format";
import { cn } from "@/lib/utils";
import { amcName, assetClass, GROUP_BYS, groupBook, shortCategory, slices, type BookHolding, type GroupBy, type GroupNode } from "@/lib/domain/book";
import type { TrendPoint } from "@/services/book";

export const ALLOCS = [{ key: "class", label: "Asset class" }, { key: "category", label: "Category" }, { key: "amc", label: "AMC" }] as const;
export type Alloc = (typeof ALLOCS)[number]["key"];

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

/**
 * The book: money in funds month by month, allocation, and "look at the book by". Shown on
 * Overview → Book. `href` builds this page's link with one setting changed (allocation / grouping).
 */
export function BookView({ trend, holdings, alloc, by, canAdvise, href }: {
  trend: TrendPoint[];
  holdings: BookHolding[];
  alloc: Alloc;
  by: GroupBy;
  canAdvise: boolean;
  href: (patch: Record<string, string | null>) => string;
}) {
  const firstTrend = trend.find((p) => p.value > 0);
  const total = holdings.reduce((t, h) => t + h.value, 0);
  const allocation = slices(holdings, alloc === "class" ? (h) => assetClass(h.category, h.scheme_name) : alloc === "category" ? (h) => shortCategory(h.category, h.scheme_name) : (h) => amcName(h.amc), 8);
  const groups = groupBook(holdings, by, { fundLinks: canAdvise });
  return (
    <div className="space-y-4">
      <div className="grid items-start gap-4 xl:grid-cols-2">
        <section id="trend" aria-label="Money in funds, month by month" className="space-y-3 rounded-xl border border-border bg-surface p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-[15px] font-semibold">Money in funds, month by month</h2>
            {firstTrend ? <span className="text-xs text-slate-600">{formatINRCompact(firstTrend.value)} ({firstTrend.clients} client{firstTrend.clients === 1 ? "" : "s"}) → <b className="text-ink">{formatINRCompact(trend[trend.length - 1].value)}</b> ({trend[trend.length - 1].clients}) · new clients, new money and the market</span> : null}
          </div>
          <BookTrend points={trend} />
          <p className="text-[11px] text-muted">Each month: every client&rsquo;s latest confirmed CAS by then. This month: units × today&rsquo;s NAV.</p>
        </section>
        <section id="allocation" aria-label="Allocation" className="rounded-xl border border-border bg-surface p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[15px] font-semibold">Allocation</h2>
            <span className="flex rounded-md border border-border bg-white p-0.5 text-xs">
              {ALLOCS.map((a) => <Link key={a.key} href={`${href({ alloc: a.key === "class" ? null : a.key })}#allocation`} className={cn("rounded px-2.5 py-1", alloc === a.key ? "bg-ink text-white" : "text-slate-600")}>{a.label}</Link>)}
            </span>
          </div>
          {total > 0 ? <AllocationDonut slices={allocation} total={total} /> : <p className="text-sm text-muted">No confirmed CAS yet.</p>}
        </section>
      </div>
      <section id="by" aria-label="Look at the book by" className="overflow-hidden rounded-xl border border-border bg-surface">
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
    </div>
  );
}
