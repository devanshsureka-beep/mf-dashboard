"use client";

import Link from "next/link";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { formatDayMonth, formatINRCompact, formatUnits, humanize } from "@/lib/format";
import type { DeskRow, FundAudienceRow, FundAdvised } from "@/services/advise-desk";

/** IST days ago, as worked out on the server (no clock read in the browser). */
const ago = (days: number | null) => (days == null ? null : days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`);
const old = (days: number | null, limit = 30) => days == null || days > limit;
const L = (v: number) => (v >= 0.5 ? formatINRCompact(v) : "—");
const PAGE = 25;

function Check({ on, label, onChange }: { on: boolean; label: string; onChange: () => void }) {
  return <input type="checkbox" checked={on} onChange={onChange} aria-label={label} className="h-5 w-5 cursor-pointer accent-brand" />;
}

/** The dark bar that appears once clients are ticked. */
function SelectionBar({ count, figures, actions }: { count: number; figures: React.ReactNode; actions: React.ReactNode }) {
  if (!count) return null;
  return (
    <div className="sticky bottom-3 z-30 mt-4 flex flex-wrap items-center gap-3 rounded-xl bg-ink px-4 py-3 text-white shadow-lg">
      <span className="text-sm"><b>{count}</b> client{count === 1 ? "" : "s"} selected · {figures}</span>
      <span className="flex-1" />
      {actions}
    </div>
  );
}

const queueHref = (ids: string[]) => (ids.length ? `/advice/new?client=${ids[0]}${ids.length > 1 ? `&queue=${ids.slice(1).join(",")}` : ""}` : "#");

function BarLink({ href, primary, disabled, children }: { href: string; primary?: boolean; disabled?: boolean; children: React.ReactNode }) {
  if (disabled) return <span className="flex h-11 items-center rounded-lg px-4 text-sm text-slate-400">{children}</span>;
  return (
    <Link href={href} className={cn("flex h-11 items-center rounded-lg px-4 text-sm", primary ? "bg-white font-bold text-ink hover:bg-slate-100" : "border border-slate-500 font-semibold text-white hover:bg-white/10")}>
      {children}
    </Link>
  );
}

function useSelection() {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return { sel, setSel, toggle };
}

// ---------------------------------------------------------------------------
// All clients
// ---------------------------------------------------------------------------
export function DeskTable({ rows, caption }: { rows: DeskRow[]; caption: string }) {
  const { sel, setSel, toggle } = useSelection();
  const [limit, setLimit] = useState(PAGE);
  const picked = rows.filter((r) => sel.has(r.client_id));
  const sum = (fn: (r: DeskRow) => number) => picked.reduce((t, r) => t + fn(r), 0);
  const withPlan = picked.filter((r) => r.has_plan).map((r) => r.client_id);

  return (
    <>
      <section className="overflow-hidden rounded-xl border border-border bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <span className="text-sm"><b>{caption}</b> <span className="text-muted">· {rows.length} client{rows.length === 1 ? "" : "s"}</span></span>
          <span className="flex gap-2">
            <button type="button" className="h-9 rounded-md border border-border px-3 text-xs hover:bg-slate-50" onClick={() => setSel(new Set(rows.map((r) => r.client_id)))}>Select all {rows.length}</button>
            <button type="button" className="h-9 rounded-md border border-border px-3 text-xs hover:bg-slate-50" onClick={() => setSel(new Set())}>Clear</button>
          </span>
        </div>
        {rows.length === 0 ? <p className="px-4 py-6 text-sm text-muted">No client matches. Try another ready list or loosen a filter.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1080px] text-[13px]">
              <thead className="bg-slate-50 text-left text-[11px] font-semibold uppercase tracking-wide text-muted">
                <tr>
                  <th className="w-11 px-4 py-2" />
                  <th className="px-2 py-2">Client</th>
                  <th className="px-2 py-2 text-right">Value</th>
                  <th className="px-2 py-2 text-right">Cash</th>
                  <th className="px-2 py-2 text-right">Plan left</th>
                  <th className="px-2 py-2">Last tranche</th>
                  <th className="px-2 py-2">Waiting</th>
                  <th className="px-2 py-2">Plan says next</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, limit).map((r) => {
                  const on = sel.has(r.client_id);
                  const busy = r.pending_total >= 0.5;
                  return (
                    <tr key={r.client_id} onClick={() => toggle(r.client_id)} className={cn("cursor-pointer border-t border-slate-100 align-top", on ? "bg-brand-50/60" : "hover:bg-slate-50")}>
                      <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}><Check on={on} label={`Select ${r.full_name}`} onChange={() => toggle(r.client_id)} /></td>
                      <td className="px-2 py-2.5">
                        <Link href={`/clients/${r.client_id}`} onClick={(e) => e.stopPropagation()} className="font-semibold hover:underline">{r.full_name}</Link>
                        <div className="text-[11.5px] text-muted">{r.client_code} · {humanize(r.risk_profile)}{r.advisor_name ? ` · ${r.advisor_name}` : ""}</div>
                      </td>
                      <td className="px-2 py-2.5 text-right num">{L(r.value)}</td>
                      <td className={cn("px-2 py-2.5 text-right font-semibold num", r.in_bank >= 0.5 ? "text-emerald-700" : "text-muted")}>{L(r.in_bank)}</td>
                      <td className="px-2 py-2.5 text-right text-[12.5px] num">
                        {r.buy_left >= 0.5 ? <div className="text-blue-700">Buy {formatINRCompact(r.buy_left)}</div> : null}
                        {r.sell_left >= 0.5 ? <div className="text-red-700">Sell {formatINRCompact(r.sell_left)}</div> : null}
                        {r.buy_left < 0.5 && r.sell_left < 0.5 ? <span className="text-muted">{r.has_plan ? "nothing left" : "no plan"}</span> : null}
                      </td>
                      <td className="px-2 py-2.5">
                        {r.last_tranche_at ? <><div>{formatDayMonth(r.last_tranche_at)} · {r.last_tranche_calls} call{r.last_tranche_calls === 1 ? "" : "s"}</div><div className={cn("text-[11.5px] font-semibold", old(r.last_tranche_days) ? "text-red-700" : "text-muted")}>{ago(r.last_tranche_days)}</div></>
                          : <span className="text-[12px] font-semibold text-red-700">No tranche yet</span>}
                      </td>
                      <td className={cn("px-2 py-2.5 text-[12.5px]", busy ? "font-semibold text-amber-700" : "text-muted")}>{busy ? `${r.open_calls} call${r.open_calls === 1 ? "" : "s"} · ${formatINRCompact(r.pending_total)}` : "—"}</td>
                      <td className="max-w-[22rem] px-2 py-2.5 text-[12.5px] text-slate-700">
                        {r.next.length ? r.next.slice(0, 2).map((n, i) => (
                          <div key={i} className="truncate"><b className={n.action === "BUY" ? "text-blue-700" : "text-red-700"}>{humanize(n.action)}</b> {n.scheme_name} {formatINRCompact(n.amount)}</div>
                        )) : <span className="text-muted">{r.has_plan ? "Plan fully advised" : "No active plan"}</span>}
                        {r.next.length > 2 || r.next_more ? <div className="text-[11.5px] text-muted">+{r.next.length - 2 + r.next_more} more</div> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {rows.length > limit ? (
          <div className="border-t border-border p-2 text-center"><button type="button" className="h-10 px-4 text-sm text-brand hover:underline" onClick={() => setLimit((l) => l + PAGE)}>Show the next {Math.min(PAGE, rows.length - limit)}</button></div>
        ) : null}
      </section>
      <SelectionBar
        count={picked.length}
        figures={<>cash <b className="text-emerald-300">{L(sum((r) => r.in_bank))}</b> · plan buys <b className="text-indigo-200">{L(sum((r) => r.buy_left))}</b> · plan sells <b className="text-red-300">{L(sum((r) => r.sell_left))}</b></>}
        actions={<>
          <BarLink href={queueHref(withPlan)} primary disabled={!withPlan.length}>Advise each from their plan{withPlan.length !== picked.length ? ` (${withPlan.length})` : ""} →</BarLink>
          <BarLink href={`/advice/bulk?ids=${picked.map((r) => r.client_id).join(",")}`}>One call for all →</BarLink>
        </>}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// One fund
// ---------------------------------------------------------------------------
const ADVISED: Record<FundAdvised, { label: string; cls: string }> = {
  NOT_ADVISED: { label: "Not advised", cls: "bg-amber-50 text-amber-900 ring-1 ring-amber-200" },
  WAITING: { label: "Advised · waiting", cls: "bg-indigo-50 text-indigo-800" },
  PART_DONE: { label: "Advised · part done", cls: "bg-emerald-50 text-emerald-800" },
  DONE: { label: "Done", cls: "bg-emerald-700 text-white" },
  NO_CALL: { label: "No call needed", cls: "bg-slate-100 text-slate-600" },
  NOT_IN_PLAN: { label: "Not in plan", cls: "bg-white text-slate-600 ring-1 ring-slate-200" },
};

function planPill(r: FundAudienceRow) {
  const p = r.plan;
  if (!p) return { text: r.row.has_plan ? "Not in plan" : "No active plan", cls: "bg-white text-slate-600 ring-1 ring-slate-200" };
  if (p.side === "NONE") return { text: humanize(p.action === "RETAIN" ? "HOLD" : p.action), cls: "bg-slate-100 text-slate-700" };
  if (p.left < 0.5) {
    const done = p.executed >= p.target - 0.5;
    return { text: done ? (p.side === "BUY" ? "Bought as planned" : "Sold as planned") : `${p.side === "BUY" ? "Buy" : "Sell"} fully advised`, cls: "bg-slate-100 text-slate-700" };
  }
  if (p.side === "SELL" && p.full_exit) return { text: `Full exit · ${formatINRCompact(p.left)}`, cls: "bg-red-700 text-white" };
  return p.side === "BUY"
    ? { text: `Buy ${formatINRCompact(p.left)}${r.holding ? " more" : ""}`, cls: "bg-blue-50 text-blue-800" }
    : { text: `Sell ${formatINRCompact(p.left)}`, cls: "bg-red-50 text-red-800" };
}

function advisedNote(r: FundAudienceRow) {
  const told = r.open ? `${formatINRCompact(r.open.advised)} told ${formatDayMonth(r.open.since)} · ${ago(r.open.since_days)}${r.open.executed >= 0.5 ? ` · ${formatINRCompact(r.open.executed)} done` : ""}` : "";
  if (r.open && r.advised === "NOT_ADVISED") return `${formatINRCompact(r.plan?.left ?? 0)} still to advise · ${told}`;
  if (r.open) return told;
  if (r.advised === "DONE" && r.done_on) return `done ${formatDayMonth(r.done_on)}`;
  if (r.advised === "NOT_ADVISED") return r.row.last_tranche_at ? "nothing told yet" : "first call for this client";
  return "";
}

type Tab = "all" | "holders" | "buyers";

export function FundTable({ rows, securityId }: { rows: FundAudienceRow[]; securityId: string }) {
  const { sel, setSel, toggle } = useSelection();
  const [tab, setTab] = useState<Tab>("all");
  const holders = rows.filter((r) => r.holding);
  const buyers = rows.filter((r) => !r.holding);
  const shown = tab === "holders" ? holders : tab === "buyers" ? buyers : rows;
  const todo = (side: "BUY" | "SELL") => rows.filter((r) => r.advised === "NOT_ADVISED" && r.plan?.side === side);
  const picked = rows.filter((r) => sel.has(r.row.client_id));
  const ids = picked.map((r) => r.row.client_id);
  const left = (side: "BUY" | "SELL") => picked.filter((r) => r.plan?.side === side && r.advised === "NOT_ADVISED").reduce((t, r) => t + (r.plan?.left ?? 0), 0);
  const sides = new Set(picked.map((r) => r.plan?.side).filter((s) => s === "BUY" || s === "SELL"));
  const side = sides.size === 1 ? [...sides][0] : null;
  const withPlan = picked.filter((r) => r.row.has_plan).map((r) => r.row.client_id);
  const tabs: [Tab, string][] = [["all", `Everyone · ${rows.length}`], ["holders", `Hold it · ${holders.length}`], ["buyers", `Don't hold it · ${buyers.length}`]];

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Who to show" className="flex gap-1 rounded-xl bg-slate-200/70 p-1">
          {tabs.map(([k, label]) => (
            <button key={k} type="button" aria-pressed={tab === k} onClick={() => setTab(k)}
              className={cn("h-10 rounded-lg px-4 text-sm", tab === k ? "bg-white font-semibold shadow-sm" : "text-slate-600 hover:text-ink")}>{label}</button>
          ))}
        </nav>
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <span className="text-muted">Quick select:</span>
          <button type="button" disabled={!todo("BUY").length} onClick={() => setSel(new Set(todo("BUY").map((r) => r.row.client_id)))}
            className="h-10 rounded-full border border-blue-200 bg-blue-50 px-3.5 font-semibold text-blue-800 disabled:opacity-40">Plan says buy, not advised · {todo("BUY").length}</button>
          <button type="button" disabled={!todo("SELL").length} onClick={() => setSel(new Set(todo("SELL").map((r) => r.row.client_id)))}
            className="h-10 rounded-full border border-red-200 bg-red-50 px-3.5 font-semibold text-red-800 disabled:opacity-40">Plan says sell, not advised · {todo("SELL").length}</button>
          <button type="button" onClick={() => setSel(new Set())} className="h-10 rounded-full border border-border bg-white px-3.5">None</button>
        </div>
      </div>

      <section className="mt-3 overflow-hidden rounded-xl border border-border bg-white">
        {shown.length === 0 ? <p className="px-4 py-6 text-sm text-muted">{tab === "buyers" ? "Every client listed holds this fund." : "Nobody here."}</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1080px] text-[13px]">
              <thead className="bg-slate-50 text-left text-[11px] font-semibold uppercase tracking-wide text-muted">
                <tr>
                  <th className="w-11 px-4 py-2" />
                  <th className="px-2 py-2">Client</th>
                  <th className="px-2 py-2 text-right">Holds</th>
                  <th className="px-2 py-2">Plan says</th>
                  <th className="px-2 py-2">Advised?</th>
                  <th className="px-2 py-2 text-right">Cash</th>
                  <th className="px-2 py-2">Last tranche</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const on = sel.has(r.row.client_id);
                  const pp = planPill(r);
                  const share = r.holding && r.row.value > 0 ? Math.round((r.holding.value / r.row.value) * 100) : null;
                  return (
                    <tr key={r.row.client_id} onClick={() => toggle(r.row.client_id)} className={cn("cursor-pointer border-t border-slate-100 align-top", on ? "bg-brand-50/60" : "hover:bg-slate-50")}>
                      <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}><Check on={on} label={`Select ${r.row.full_name}`} onChange={() => toggle(r.row.client_id)} /></td>
                      <td className="px-2 py-2.5">
                        <Link href={`/clients/${r.row.client_id}`} onClick={(e) => e.stopPropagation()} className="font-semibold hover:underline">{r.row.full_name}</Link>
                        <div className="text-[11.5px] text-muted">{r.row.client_code} · {humanize(r.row.risk_profile)}</div>
                      </td>
                      <td className="px-2 py-2.5 text-right">
                        {r.holding ? <>
                          <div className="font-semibold num">{formatINRCompact(r.holding.value)}</div>
                          <div className={cn("text-[11.5px]", share != null && share >= 25 ? "font-semibold text-red-700" : "text-muted")}>
                            {formatUnits(r.holding.units)} u{r.holding.plan_types ? ` · ${humanize(r.holding.plan_types)}` : ""}{share != null ? ` · ${share}% of portfolio` : ""}
                          </div>
                        </> : <span className="text-muted">not held</span>}
                      </td>
                      <td className="px-2 py-2.5"><span className={cn("inline-block rounded-full px-2.5 py-1 text-[12px] font-semibold", pp.cls)}>{pp.text}</span></td>
                      <td className="px-2 py-2.5">
                        {r.advised === "NOT_IN_PLAN" ? <span className="text-muted">—</span>
                          : <span className={cn("inline-block rounded-full px-2.5 py-1 text-[12px] font-semibold", r.open && r.advised === "NOT_ADVISED" ? "bg-amber-50 text-amber-900 ring-1 ring-amber-200" : ADVISED[r.advised].cls)}>{r.open && r.advised === "NOT_ADVISED" ? "Part advised" : ADVISED[r.advised].label}</span>}
                        {advisedNote(r) ? <div className="mt-0.5 text-[11.5px] text-muted">{advisedNote(r)}</div> : null}
                      </td>
                      <td className={cn("px-2 py-2.5 text-right font-semibold num", r.row.in_bank >= 0.5 ? "text-emerald-700" : "text-muted")}>{L(r.row.in_bank)}</td>
                      <td className="px-2 py-2.5 text-[12.5px]">
                        {r.row.last_tranche_at ? <><div>{formatDayMonth(r.row.last_tranche_at)}</div><div className={cn("text-[11.5px]", old(r.row.last_tranche_days) ? "font-semibold text-red-700" : "text-muted")}>{ago(r.row.last_tranche_days)}</div></> : <span className="font-semibold text-red-700">none yet</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <SelectionBar
        count={picked.length}
        figures={<>
          {left("BUY") >= 0.5 ? <>plan buys <b className="text-indigo-200">{formatINRCompact(left("BUY"))}</b> · </> : null}
          {left("SELL") >= 0.5 ? <>plan sells <b className="text-red-300">{formatINRCompact(left("SELL"))}</b> · </> : null}
          cash <b className="text-emerald-300">{L(picked.reduce((t, r) => t + r.row.in_bank, 0))}</b>
        </>}
        actions={<>
          <BarLink primary href={`/advice/bulk?ids=${ids.join(",")}&fund=${securityId}${side ? `&side=${side}&mode=PLAN` : ""}`}>
            {side === "BUY" ? `Buy this fund for ${ids.length} →` : side === "SELL" ? `Sell this fund for ${ids.length} →` : `One call for ${ids.length} →`}
          </BarLink>
          <BarLink href={queueHref(withPlan)} disabled={!withPlan.length}>Advise each from their plan →</BarLink>
        </>}
      />
    </>
  );
}
