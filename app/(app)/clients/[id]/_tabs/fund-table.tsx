"use client";

import Link from "next/link";
import { useState } from "react";
import { formatDate, formatINR, formatINRCompact, formatNav, formatUnits } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { FundEvent, FundRow, FundTotals } from "@/services/client-desk";

type Filter = "all" | "sell" | "buy" | "keep" | "exited";

const TONE = {
  sell: "bg-red-50 text-red-800 ring-red-200",
  buy: "bg-blue-50 text-blue-800 ring-blue-200",
  keep: "bg-slate-100 text-slate-700 ring-slate-200",
  other: "bg-violet-50 text-violet-800 ring-violet-200",
} as const;
const EVENT_TONE: Record<FundEvent["kind"], string> = {
  PLAN: "bg-violet-50 text-violet-800",
  CALL: "bg-blue-50 text-blue-800",
  EXECUTED: "bg-emerald-50 text-emerald-800",
  CAS: "bg-slate-100 text-slate-700",
};

const L = (v: number | null | undefined) => (v == null ? "—" : formatINRCompact(v));
const lastDate = (ds: string[]) => (ds.length ? ds[ds.length - 1] : null);

function PlanTypeBadge({ t }: { t: string | null }) {
  if (!t) return null;
  const regular = t.toUpperCase() === "REGULAR";
  return <span className={cn("rounded px-1.5 py-px text-[10px] font-semibold", regular ? "bg-amber-50 text-amber-800" : "bg-emerald-50 text-emerald-800")}>{regular ? "Regular" : "Direct"}</span>;
}

function Events({ events }: { events: FundEvent[] }) {
  if (!events.length) return <p className="text-xs text-muted">Nothing recorded on this fund yet.</p>;
  return (
    <ol className="divide-y divide-dashed divide-border">
      {events.map((e, i) => (
        <li key={i} className="flex items-baseline gap-2.5 py-1.5 text-[12.5px]">
          <span className="w-20 shrink-0 text-[11px] text-muted num">{formatDate(e.date)}</span>
          <span className={cn("w-[74px] shrink-0 rounded py-px text-center text-[10px] font-semibold", EVENT_TONE[e.kind])}>{e.kind === "EXECUTED" ? "DONE" : e.kind}</span>
          <span className="min-w-0 flex-1">{e.href ? <Link href={e.href} className="hover:underline">{e.text}</Link> : e.text}</span>
        </li>
      ))}
    </ol>
  );
}

function UnitsTrail({ r }: { r: FundRow }) {
  if (!r.unitsTrail.length) return <span>{r.notHeld ? "Not held yet" : "—"}</span>;
  return <span className="num">{r.unitsTrail.map((u) => `${formatDate(u.date)} ${formatUnits(u.units)}`).join(" → ")}</span>;
}

/**
 * One row per fund: what the client holds (units × NAV today, and what it was
 * at onboarding), what the plan says, and how far it got. "Done" is what the
 * CAS showed; nothing is recorded by hand.
 */
export function FundTable({ rows, totals, clientId, canAdvise, casDate, inBank }: { rows: FundRow[]; totals: FundTotals; clientId: string; canAdvise: boolean; casDate: string | null; inBank: number }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<string | null>(null);
  const [keepOpen, setKeepOpen] = useState(false);

  const tone = (r: FundRow) => r.plan?.tone ?? "keep";
  // Funds gone from the latest CAS with nothing left to do sit under "Exited".
  const gone = (r: FundRow) => r.exited && (!r.plan || r.plan.tone === "keep" || r.plan.done);
  const live = rows.filter((r) => !gone(r));
  const counts = { all: live.length, sell: live.filter((r) => tone(r) === "sell").length, buy: live.filter((r) => tone(r) === "buy").length, keep: live.filter((r) => tone(r) === "keep" || tone(r) === "other").length, exited: rows.length - live.length };
  const shown = filter === "exited" ? rows.filter(gone) : live.filter((r) => filter === "all" || (filter === "keep" ? tone(r) === "keep" || tone(r) === "other" : tone(r) === filter));

  // Three parts: funds a call was given on, Sell/Buy lines nothing was advised on yet, and the rest (Keep).
  const moves = (r: FundRow) => tone(r) === "sell" || tone(r) === "buy";
  const acted = (r: FundRow) => (r.plan?.advised ?? 0) >= 0.5;
  const stage = (r: FundRow) => (r.plan!.pending >= 0.5 ? 0 : !r.plan!.done && r.plan!.remaining >= 0.5 ? 1 : 2);
  const actedRows = shown.filter(acted).sort((a, b) => stage(a) - stage(b) || (b.plan!.pending + b.plan!.remaining) - (a.plan!.pending + a.plan!.remaining));
  const notActedRows = shown.filter((r) => !acted(r) && moves(r)).sort((a, b) => (b.plan!.remaining - a.plan!.remaining));
  const keepRows = shown.filter((r) => !acted(r) && !moves(r));
  const keepShown = filter === "keep" || keepOpen;
  const notLeft = notActedRows.reduce((s, r) => s + r.plan!.remaining, 0);
  const stageCount = (n: number) => actedRows.filter((r) => stage(r) === n).length;

  const renderRow = (r: FundRow) => {
              const isOpen = open === r.key;
              const p = r.plan;
              const moves = p && p.tone !== "keep";
              const flag = [r.notHeld ? "not bought yet" : r.isNew ? "new since onboarding" : null, r.exited ? "exited" : null, p?.note].filter(Boolean).join(" · ");
              return (
                <FragmentRow key={r.key}>
                  <tr className={cn("align-top text-right", isOpen ? "bg-brand-50/40" : "hover:bg-slate-50/70", r.exited && "text-muted")}>
                    <td className="max-w-[320px] px-4 py-2.5 text-left">
                      <button type="button" onClick={() => setOpen(isOpen ? null : r.key)} aria-expanded={isOpen} className="text-left font-semibold text-ink hover:text-brand">
                        {r.name} <span className="text-[11px] text-brand" aria-hidden>{isOpen ? "▾" : "▸"}</span>
                      </button>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                        <PlanTypeBadge t={r.planType} />
                        {moves && p.advised >= 0.5 ? <StageTag s={stage(r)} /> : null}
                        {flag ? <span className="text-[11px] text-muted">{flag}</span> : null}
                      </div>
                    </td>
                    <td className="px-2 py-2.5 text-left num">
                      <div className="text-[15px] font-bold text-ink" title={r.value != null ? formatINR(r.value) : undefined}>{r.value == null || (r.notHeld && !r.value) ? "—" : formatINR(r.value)}</div>
                      {r.units ? <div className="text-[11.5px] text-slate-700">{formatUnits(r.units)} units · NAV {formatNav(r.nav)}{r.navDate && !r.isLive ? <span className="text-amber-700"> (CAS)</span> : null}</div> : null}
                      <div className="mt-0.5 text-[11px] text-muted">Onboarding {r.onboardingValue == null ? "—" : r.onboardingValue > 0 ? formatINR(r.onboardingValue) : "₹0 (new)"}</div>
                    </td>
                    <td className="px-2 py-2.5 text-left">
                      {p ? <span className={cn("inline-block rounded-full px-2 py-0.5 text-xs font-semibold ring-1", TONE[p.tone])}>{p.done && p.tone !== "keep" ? `${p.label} · done` : p.label}</span> : <span className="text-xs text-muted">Not in plan</span>}
                    </td>
                    <td className="px-2 py-2.5">
                      <div className="font-semibold text-blue-700 num">{moves ? L(p.advised) : "—"}</div>
                      {moves && lastDate(r.advisedDates) ? <div className="text-[11px] text-muted">advised {lastDate(r.advisedDates)}</div> : null}
                    </td>
                    <td className="px-2 py-2.5">
                      <div className="font-semibold text-emerald-700 num">{moves ? L(p.executed) : "—"}</div>
                      {moves && lastDate(r.executedDates) ? <div className="text-[11px] text-muted">done {lastDate(r.executedDates)}</div> : null}
                    </td>
                    <td className="px-2 py-2.5">
                      <div className="text-amber-700 num">{moves && p.pending >= 0.5 ? L(p.pending) : "—"}</div>
                      {moves && p.pending >= 0.5 ? <div className="text-[11px] text-muted">not in CAS yet</div> : null}
                    </td>
                    <td className="py-2.5 pl-2 pr-4">
                      <div className="font-semibold num">{moves ? L(p.remaining) : "—"}</div>
                      {p?.pct != null ? <div className="ml-auto mt-1 h-1.5 w-24 rounded-full bg-slate-100"><div className="h-1.5 rounded-full bg-emerald-500" style={{ width: `${p.pct}%` }} /></div> : null}
                    </td>
                  </tr>
                  {isOpen ? (
                    <tr className="bg-slate-50/80">
                      <td colSpan={7} className="px-4 pb-3 pl-8 pt-1 text-left">
                        <div className="flex flex-wrap gap-x-6 gap-y-1 py-1.5 text-xs text-slate-700">
                          <span><b>Folio</b> {r.folio ?? "—"}</span>
                          <span><b>Units by CAS</b> <UnitsTrail r={r} /></span>
                          {p ? <span><b>Plan line</b> {p.label} · target {L(p.target)} · {p.status}</span> : null}
                        </div>
                        <Events events={r.events} />
                        {canAdvise && p && p.tone !== "keep" && p.remaining > 0.5 ? (
                          <Link href={`/advice/new?client=${clientId}&planItem=${p.planItemId}`} className="mt-2 inline-block rounded-md bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700">Issue call on this fund</Link>
                        ) : null}
                      </td>
                    </tr>
                  ) : null}
                </FragmentRow>
              );
  };

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div>
          <div className="text-sm font-semibold">Every fund and what&apos;s left on it</div>
          <div className="text-xs text-muted">{casDate && rows.length ? <>Units from CAS {formatDate(casDate)} · valued at today&apos;s NAV · click a fund for its history</> : "No mutual funds yet: the first CAS shows the funds bought"}</div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {(["all", "sell", "buy", "keep", "exited"] as Filter[]).filter((f) => f !== "exited" || counts.exited > 0).map((f) => (
            <button key={f} type="button" onClick={() => setFilter(f)} aria-pressed={filter === f}
              className={cn("rounded-full px-2.5 py-1 ring-1", filter === f ? "bg-ink text-white ring-ink" : "bg-white ring-border hover:bg-slate-50")}>
              {{ all: "All", sell: "Sell", buy: "Buy", keep: "Keep", exited: "Exited" }[f]} {counts[f]}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[1040px] text-[13px]">
          <thead className="bg-slate-50 text-right text-[10.5px] font-semibold uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2 text-left">Fund</th>
              <th className="px-2 py-2 text-left">Holding</th>
              <th className="px-2 py-2 text-left">Plan</th>
              <th className="px-2 py-2">Advised</th>
              <th className="px-2 py-2">Done (CAS)</th>
              <th className="px-2 py-2">Waiting</th>
              <th className="w-36 py-2 pl-2 pr-4">Left to advise</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {filter === "exited" ? shown.map(renderRow) : (
              <>
                {actedRows.length ? (
                  <>
                    <Section dot="bg-emerald-600" title="Acted on" sub={`${actedRows.length} ${actedRows.length === 1 ? "fund" : "funds"} with a call · ${[stageCount(0) ? `${stageCount(0)} waiting for CAS` : null, stageCount(1) ? `${stageCount(1)} partly done` : null, stageCount(2) ? `${stageCount(2)} done` : null].filter(Boolean).join(" · ")}`} />
                    {actedRows.map(renderRow)}
                  </>
                ) : null}
                {notActedRows.length ? (
                  <>
                    <Section dot="bg-amber-600" title="Not acted yet" sub={`${notActedRows.length} ${notActedRows.length === 1 ? "fund" : "funds"} in the plan, nothing advised · ${formatINRCompact(notLeft)} to advise · biggest first`} className="bg-amber-50/60" />
                    {notActedRows.map(renderRow)}
                  </>
                ) : null}
                {keepRows.length ? (
                  <>
                    <tr className="bg-slate-50">
                      <td colSpan={7} className="p-0">
                        <button type="button" onClick={() => setKeepOpen(!keepOpen)} aria-expanded={keepShown} disabled={filter === "keep"}
                          className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-[13px] hover:bg-slate-100 disabled:hover:bg-transparent">
                          <span className="text-[11px] text-brand" aria-hidden>{keepShown ? "▾" : "▸"}</span>
                          <span className="font-semibold">Keep · no action ({keepRows.length})</span>
                          <span className="text-xs text-muted">{keepShown ? "held as the plan says" : `${formatINRCompact(keepRows.reduce((s, r) => s + (r.value ?? 0), 0))} held · click to show`}</span>
                        </button>
                      </td>
                    </tr>
                    {keepShown ? keepRows.map(renderRow) : null}
                  </>
                ) : null}
              </>
            )}
            <tr className="bg-slate-50 text-right font-semibold">
              <td className="px-4 py-2.5 text-left">
                Total · {rows.filter((r) => !r.notHeld && !r.exited).length} funds
                {inBank >= 0.5 ? <span className="ml-1.5 text-[11px] font-normal text-muted">+ {formatINRCompact(inBank)} in bank</span> : null}
              </td>
              <td className="px-2 py-2.5 text-left num">{formatINRCompact(totals.value)} today <span className="text-[11px] font-normal text-muted">· {formatINRCompact(totals.onboarding)} at onboarding</span></td>
              <td className="px-2 py-2.5 text-left text-xs font-normal text-muted">Sell {formatINRCompact(totals.sellTarget)} · Buy {formatINRCompact(totals.buyTarget)}</td>
              <td className="px-2 py-2.5 text-blue-700 num">{formatINRCompact(totals.advised)}</td>
              <td className="px-2 py-2.5 text-emerald-700 num">{formatINRCompact(totals.executed)}</td>
              <td className="px-2 py-2.5 text-amber-700 num">{formatINRCompact(totals.pending)}</td>
              <td className="py-2.5 pl-2 pr-4 num">{formatINRCompact(totals.remaining)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function StageTag({ s }: { s: number }) {
  const [label, cls] = [["Waiting for CAS", "bg-amber-100 text-amber-900"], ["Partly done", "bg-blue-100 text-blue-900"], ["Done", "bg-emerald-100 text-emerald-900"]][s];
  return <span className={cn("rounded px-1.5 py-px text-[10px] font-semibold", cls)}>{label}</span>;
}

function Section({ dot, title, sub, className }: { dot: string; title: string; sub: string; className?: string }) {
  return (
    <tr className={cn("bg-white", className)}>
      <td colSpan={7} className="px-4 pb-2 pt-4 text-left">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className={cn("h-2 w-2 rounded-full", dot)} aria-hidden />
          <span className="text-[13.5px] font-semibold text-ink">{title}</span>
          <span className="text-xs text-muted">{sub}</span>
        </div>
      </td>
    </tr>
  );
}

function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
