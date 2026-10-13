"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { formatDate, formatINR, formatINRCompact, formatNav, formatUnits } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { FundEvent, FundRow, FundTotals } from "@/services/client-desk";

type Mode = "expand" | "panel";
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
const signed = (v: number) => `${v >= 0 ? "+" : "−"}${formatINRCompact(Math.abs(v))}`;
const datesLine = (ds: string[]) => (ds.length === 0 ? null : ds.length <= 3 ? ds.join(" & ") : `${ds.slice(-2).join(" & ")} +${ds.length - 2}`);

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
          <span className={cn("w-[74px] shrink-0 rounded py-px text-center text-[10px] font-semibold", EVENT_TONE[e.kind])}>{e.kind}</span>
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

// The chosen "clicking a fund opens" mode is remembered per browser.
function readMode(): Mode {
  try { return localStorage.getItem("fundOpenMode") === "panel" ? "panel" : "expand"; } catch { return "expand"; }
}
function subscribeMode(cb: () => void) {
  window.addEventListener("fund-open-mode", cb);
  window.addEventListener("storage", cb);
  return () => { window.removeEventListener("fund-open-mode", cb); window.removeEventListener("storage", cb); };
}

export function FundTable({ rows, totals, clientId, canAdvise, casDate }: { rows: FundRow[]; totals: FundTotals; clientId: string; canAdvise: boolean; casDate: string | null }) {
  const mode = useSyncExternalStore(subscribeMode, readMode, () => "expand" as Mode);
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (mode !== "panel" || !open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(null); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mode, open]);
  const pickMode = (m: Mode) => {
    setOpen(null);
    try { localStorage.setItem("fundOpenMode", m); } catch { /* private mode */ }
    window.dispatchEvent(new Event("fund-open-mode"));
  };

  const tone = (r: FundRow) => r.plan?.tone ?? "keep";
  // Funds gone from the latest CAS with nothing left to do sit under "Exited".
  const gone = (r: FundRow) => r.exited && (!r.plan || r.plan.tone === "keep" || r.plan.done);
  const live = rows.filter((r) => !gone(r));
  const counts = { all: live.length, sell: live.filter((r) => tone(r) === "sell").length, buy: live.filter((r) => tone(r) === "buy").length, keep: live.filter((r) => tone(r) === "keep" || tone(r) === "other").length, exited: rows.length - live.length };
  const shown = filter === "exited" ? rows.filter(gone) : live.filter((r) => filter === "all" || (filter === "keep" ? tone(r) === "keep" || tone(r) === "other" : tone(r) === filter));
  const sel = mode === "panel" && open ? rows.find((r) => r.key === open) ?? null : null;

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div>
          <div className="text-sm font-semibold">Every fund, what we advised on it, and how far it got</div>
          <div className="text-xs text-muted">{casDate ? `Units from CAS ${formatDate(casDate)}` : "No CAS yet"} · valued at the latest NAV · advised / executed across all tranches</div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted">Clicking a fund opens:</span>
          {(["expand", "panel"] as Mode[]).map((m) => (
            <button key={m} type="button" onClick={() => pickMode(m)} aria-pressed={mode === m}
              className={cn("rounded-full px-2.5 py-1 ring-1", mode === m ? "bg-brand text-white ring-brand" : "bg-white ring-border hover:bg-slate-50")}>
              {m === "expand" ? "Expand row" : "Side panel"}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-border" aria-hidden />
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
              <th className="px-2 py-2">Value today</th>
              <th className="px-2 py-2">Since onboarding</th>
              <th className="py-2 pl-5 pr-2 text-left">Plan</th>
              <th className="px-2 py-2">Advised</th>
              <th className="px-2 py-2">Executed</th>
              <th className="px-2 py-2">Pending</th>
              <th className="px-2 py-2">Remaining to advise</th>
              <th className="w-36 py-2 pl-2 pr-4 text-left">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {shown.map((r) => {
              const isOpen = open === r.key;
              const p = r.plan;
              return (
                <FragmentRow key={r.key}>
                  <tr className={cn("align-top text-right", isOpen ? "bg-brand-50/40" : "hover:bg-slate-50/70", r.exited && "text-muted")}>
                    <td className="max-w-[340px] px-4 py-2.5 text-left">
                      <button type="button" onClick={() => setOpen(isOpen && mode === "expand" ? null : r.key)} aria-expanded={mode === "expand" ? isOpen : undefined}
                        className="text-left font-semibold text-ink hover:text-brand">
                        {r.name} <span className="text-[11px] text-brand" aria-hidden>{isOpen && mode === "expand" ? "▾" : "▸"}</span>
                      </button>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                        <PlanTypeBadge t={r.planType} />
                        {r.category ? <span className="text-[11px] text-muted">{r.category}</span> : null}
                        {r.notHeld ? <span className="rounded bg-violet-50 px-1.5 py-px text-[10px] font-medium text-violet-800">Not bought yet</span>
                          : r.isNew ? <span className="rounded bg-violet-50 px-1.5 py-px text-[10px] font-medium text-violet-800">New since onboarding</span> : null}
                        {r.exited ? <span className="rounded bg-slate-100 px-1.5 py-px text-[10px] font-medium text-slate-700">Exited</span> : null}
                      </div>
                    </td>
                    <td className="px-2 py-2.5">
                      <div className="font-semibold text-ink num" title={r.value != null ? formatINR(r.value) : undefined}>{r.value == null ? "—" : formatINR(r.value)}</div>
                      {r.units ? <div className="text-[11px] text-muted num">{formatUnits(r.units)} u × {formatNav(r.nav)}</div> : null}
                      {r.units && r.navDate ? <div className={cn("text-[10.5px] num", r.isLive ? "text-muted" : "text-amber-700")}>NAV {formatDate(r.navDate)}{r.isLive ? "" : " · CAS"}</div> : null}
                    </td>
                    <td className="px-2 py-2.5">
                      <div className={cn("font-medium num", r.change == null ? "text-muted" : r.change >= 0 ? "text-emerald-700" : "text-red-700")}>{r.change == null ? "—" : signed(r.change)}</div>
                      {r.onboardingValue != null ? <div className="text-[11px] text-muted num">was {r.onboardingValue > 0 ? formatINR(r.onboardingValue) : "₹0 (new)"}</div> : null}
                    </td>
                    <td className="py-2.5 pl-5 pr-2 text-left">
                      {p ? <span className={cn("inline-block rounded-full px-2 py-0.5 text-xs font-semibold ring-1", TONE[p.tone])}>{p.done && p.tone !== "keep" ? `${p.label} · done` : p.label}</span> : <span className="text-xs text-muted">Not in plan</span>}
                      {p?.note ? <div className="mt-0.5 text-[11px] text-muted">{p.note}</div> : null}
                    </td>
                    <td className="px-2 py-2.5">
                      <div className="font-semibold text-blue-700 num">{p && p.tone !== "keep" ? L(p.advised) : "—"}</div>
                      {datesLine(r.advisedDates) ? <div className="text-[11px] text-muted">{datesLine(r.advisedDates)}</div> : null}
                    </td>
                    <td className="px-2 py-2.5">
                      <div className="font-semibold text-emerald-700 num">{p && p.tone !== "keep" ? L(p.executed) : "—"}</div>
                      {datesLine(r.executedDates) ? <div className="text-[11px] text-muted">{datesLine(r.executedDates)}</div> : null}
                    </td>
                    <td className="px-2 py-2.5 text-amber-700 num">{p && p.tone !== "keep" ? L(p.pending) : "—"}</td>
                    <td className="px-2 py-2.5 font-semibold num">{p && p.tone !== "keep" ? L(p.remaining) : "—"}</td>
                    <td className="py-3 pl-2 pr-4 text-left">
                      {p?.pct != null ? (
                        <div className="h-1.5 rounded-full bg-slate-100"><div className="h-1.5 rounded-full bg-emerald-500" style={{ width: `${p.pct}%` }} /></div>
                      ) : null}
                      <div className="mt-1 text-[11px] text-muted">{p ? p.status : "—"}</div>
                    </td>
                  </tr>
                  {isOpen && mode === "expand" ? (
                    <tr className="bg-slate-50/80">
                      <td colSpan={9} className="px-4 pb-3 pl-8 pt-1 text-left">
                        <div className="flex flex-wrap gap-x-6 gap-y-1 py-1.5 text-xs text-slate-700">
                          <span><b>Folio</b> {r.folio ?? "—"}</span>
                          <span><b>Units by CAS</b> <UnitsTrail r={r} /></span>
                          {p ? <span><b>Plan line</b> {p.label} · target {L(p.target)}</span> : null}
                        </div>
                        <Events events={r.events} />
                        <FundActions r={r} clientId={clientId} canAdvise={canAdvise} />
                      </td>
                    </tr>
                  ) : null}
                </FragmentRow>
              );
            })}
            <tr className="bg-slate-50 text-right font-semibold">
              <td className="px-4 py-2.5 text-left">Total · {rows.filter((r) => !r.notHeld && !r.exited).length} funds held</td>
              <td className="px-2 py-2.5 num">{formatINRCompact(totals.value)}</td>
              <td className={cn("px-2 py-2.5 num", totals.value - totals.onboarding >= 0 ? "text-emerald-700" : "text-red-700")}>
                {signed(totals.value - totals.onboarding)}<div className="text-[11px] font-normal text-muted">was {formatINRCompact(totals.onboarding)}</div>
              </td>
              <td className="py-2.5 pl-5 pr-2 text-left text-xs font-normal text-muted">Sell {formatINRCompact(totals.sellTarget)} · Buy {formatINRCompact(totals.buyTarget)}</td>
              <td className="px-2 py-2.5 text-blue-700 num">{formatINRCompact(totals.advised)}</td>
              <td className="px-2 py-2.5 text-emerald-700 num">{formatINRCompact(totals.executed)}</td>
              <td className="px-2 py-2.5 text-amber-700 num">{formatINRCompact(totals.pending)}</td>
              <td className="px-2 py-2.5 num">{formatINRCompact(totals.remaining)}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
      <p className="border-t border-border px-4 py-2 text-xs text-muted">Folio numbers show when you open a fund. Click a fund name to see its calls, executions and CAS trades.</p>

      {sel ? (
        <>
          <div className="fixed inset-0 z-40 bg-slate-900/20" onClick={() => setOpen(null)} aria-hidden />
          <aside role="dialog" aria-label={`${sel.name} details`} className="fixed inset-y-0 right-0 z-50 flex w-[440px] max-w-full flex-col gap-3 overflow-y-auto border-l border-border bg-white p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-base font-semibold">{sel.name}</div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted"><PlanTypeBadge t={sel.planType} />{sel.category}{sel.folio ? ` · Folio ${sel.folio}` : ""}</div>
              </div>
              <button type="button" onClick={() => setOpen(null)} aria-label="Close" className="h-8 w-8 shrink-0 rounded-md bg-slate-100 text-slate-700 hover:bg-slate-200">✕</button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg bg-slate-50 px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">Value today</div>
                <div className="text-lg font-semibold num">{sel.value == null ? "—" : formatINR(sel.value)}</div>
                {sel.units ? <div className="text-[11px] text-muted num">{formatUnits(sel.units)} u × {formatNav(sel.nav)}</div> : null}
              </div>
              <div className="rounded-lg bg-slate-50 px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">Since onboarding</div>
                <div className={cn("text-lg font-semibold num", sel.change == null ? "" : sel.change >= 0 ? "text-emerald-700" : "text-red-700")}>{sel.change == null ? "—" : signed(sel.change)}</div>
                {sel.onboardingValue != null ? <div className="text-[11px] text-muted num">was {sel.onboardingValue > 0 ? formatINR(sel.onboardingValue) : "₹0 (new)"}</div> : null}
              </div>
            </div>
            {sel.plan ? (
              <div className="rounded-lg border border-border px-3 py-2.5">
                <div className="flex items-center justify-between"><b className="text-sm">Plan</b><span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold ring-1", TONE[sel.plan.tone])}>{sel.plan.label}</span></div>
                {sel.plan.tone !== "keep" ? (
                  <div className="mt-2 grid grid-cols-4 gap-1.5 text-xs num">
                    <div><div className="text-[10px] text-muted">ADVISED</div><b className="text-blue-700">{L(sel.plan.advised)}</b><div className="text-[10px] text-muted">{datesLine(sel.advisedDates)}</div></div>
                    <div><div className="text-[10px] text-muted">EXECUTED</div><b className="text-emerald-700">{L(sel.plan.executed)}</b><div className="text-[10px] text-muted">{datesLine(sel.executedDates)}</div></div>
                    <div><div className="text-[10px] text-muted">PENDING</div><b className="text-amber-700">{L(sel.plan.pending)}</b></div>
                    <div><div className="text-[10px] text-muted">REMAINING</div><b>{L(sel.plan.remaining)}</b></div>
                  </div>
                ) : null}
                {sel.plan.note ? <div className="mt-1.5 text-[11px] text-muted">{sel.plan.note}</div> : null}
              </div>
            ) : null}
            <div className="text-sm"><b>Units by CAS</b><div className="mt-0.5 text-xs text-slate-700"><UnitsTrail r={sel} /></div></div>
            <div className="text-sm"><b>What happened on this fund</b><div className="mt-1"><Events events={sel.events} /></div></div>
            <FundActions r={sel} clientId={clientId} canAdvise={canAdvise} />
          </aside>
        </>
      ) : null}
    </section>
  );
}

function FundActions({ r, clientId, canAdvise }: { r: FundRow; clientId: string; canAdvise: boolean }) {
  const p = r.plan;
  return (
    <div className="mt-2 flex flex-wrap gap-2 text-xs">
      {canAdvise && p && p.tone !== "keep" && p.remaining > 0.5 ? (
        <Link href={`/advice/new?client=${clientId}&planItem=${p.planItemId}`} className="rounded-md bg-brand px-3 py-1.5 font-medium text-white hover:bg-brand-700">Issue call on this fund</Link>
      ) : null}
      {p && p.pending > 0.5 ? <Link href={`/executions/pending?client=${clientId}`} className="rounded-md border border-border bg-white px-3 py-1.5 font-medium hover:bg-slate-50">Record execution</Link> : null}
    </div>
  );
}

function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
