"use client";

import { useActionState, useMemo, useState } from "react";
import { safeAction } from "@/lib/safe-action";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { formatINR, formatINRCompact, formatUnits, toISTDateTimeLocal } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ActionResult } from "@/lib/actions";
import { FundPicker, type PickedFund } from "@/components/app/fund-picker";
import type { FundOption } from "@/services/fund-search";
import { CHANNELS } from "@/types/domain";

export interface AdvisablePlanItem {
  id: string;
  security_id: string | null;
  scheme_name: string;
  action: string;
  side: "SELL" | "BUY";
  target_amount: number;
  advised_amount: number;
  pending_amount: number;
  yet_to_advise_amount: number;
  /** Full exit (sell the whole holding, nothing advised yet): all units of that holding. */
  full_exit_units?: number | null;
}
export interface HoldingLite { security_id: string; scheme_name: string; units: number; nav: number | null; folio: string | null }
/** A SIP the latest CAS shows running (offered as a Stop SIP line with a full portfolio redemption). */
export interface RunningSip { security_id: string; scheme_name: string; amount: number }

/** How much a line advises: Full (all units held / all left to advise), a rupee amount, or units. */
type Mode = "FULL" | "AMOUNT" | "UNITS";
interface PlanRow { include: boolean; mode: Mode; amount: string; units: string; price: string }
interface OffRow { key: number; fund: PickedFund | null; action: "BUY" | "SELL"; mode: Mode; amount: string; units: string; price: string }

type Action = (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;

/** A typed number, tolerant of Indian grouping and a ₹ sign ("₹1,00,000"); 0 when empty or not a number. */
const num = (v: string) => {
  const n = Number(v.replace(/[₹,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const secOf = (v: string | null | undefined) => (v && v.startsWith("sec:") ? v.slice(4) : v && /^[0-9a-f-]{36}$/i.test(v) ? v : null);

function ModeSwitch({ mode, onChange, full, units = true, fullTitle }: { mode: Mode; onChange: (m: Mode) => void; full: boolean; units?: boolean; fullTitle: string }) {
  const btn = (m: Mode, label: string, disabled = false, title?: string) => (
    <button type="button" disabled={disabled} title={title} aria-pressed={mode === m} onClick={() => onChange(m)}
      className={cn("h-8 px-2.5 text-xs disabled:cursor-not-allowed disabled:opacity-40", m !== "FULL" && "border-l border-border",
        mode === m ? "bg-brand font-semibold text-white" : "bg-white text-slate-700 hover:bg-slate-50")}>
      {label}
    </button>
  );
  return (
    <div className="flex shrink-0 overflow-hidden rounded-md border border-border">
      {btn("FULL", "Full", !full, fullTitle)}
      {btn("AMOUNT", "₹")}
      {units ? btn("UNITS", "Units") : null}
    </div>
  );
}

/** Advising several clients one after another (from Find clients). */
export interface QueueStep {
  /** The clients still to come, in order. */
  next: string[];
  done: number;
  skipped: number;
  nextName: string | null;
  skipHref: string;
  /** Time and channel set on the first client, kept for the rest of the round. */
  at?: string;
  channel?: string;
}

export function IssueAdviceForm({
  action, planItems, holdings, searchFunds, side, preselect, advisors, runningSips = [], queue, cash,
}: {
  action: Action;
  planItems: AdvisablePlanItem[];
  holdings: HoldingLite[];
  searchFunds: (q: string) => Promise<FundOption[]>;
  side: "SELL" | "BUY" | "ALL";
  preselect?: string | null;
  advisors?: { id: string; full_name: string }[];
  runningSips?: RunningSip[];
  queue?: QueueStep;
  /** Cash in bank: the bar shows what is left after these calls. */
  cash?: number;
}) {
  // A new wrapper per render is fine: React always calls the latest action passed in.
  const safe = safeAction(action);
  const [state, formAction, pending] = useActionState(safe, null);
  const navOf = useMemo(() => new Map(holdings.map((h) => [h.security_id, h.nav])), [holdings]);
  // Units of a fund across all its folios (the CAS lists folios separately).
  const unitsOf = useMemo(() => {
    const m = new Map<string, number>();
    for (const h of holdings) m.set(h.security_id, Math.round(((m.get(h.security_id) ?? 0) + Number(h.units)) * 10000) / 10000);
    return m;
  }, [holdings]);
  const funds = useMemo(() => [...unitsOf.entries()].map(([id, units]) => {
    const h = holdings.find((x) => x.security_id === id)!;
    const nav = navOf.get(id) ?? null;
    return { security_id: id, scheme_name: h.scheme_name, units, nav, value: nav ? units * nav : 0 };
  }).filter((f) => f.units > 0).sort((a, b) => b.value - a.value), [unitsOf, holdings, navOf]);
  const visible = planItems.filter((p) => side === "ALL" || p.side === side);

  const held = (p: AdvisablePlanItem) => (p.security_id ? unitsOf.get(p.security_id) ?? 0 : 0);
  /** Units a Full sell advises: the plan's full exit (its own folio when it names one), else all the CAS holds. */
  const fullUnits = (p: AdvisablePlanItem) => Number(p.full_exit_units ?? 0) || held(p);
  const canFull = (p: AdvisablePlanItem) => (p.side === "SELL" ? fullUnits(p) > 0 : p.yet_to_advise_amount > 0.5);
  const initialRow = (p: AdvisablePlanItem): PlanRow => ({
    include: p.id === preselect,
    // A full exit is advised as "all units": the CAS redemption then matches exactly, whatever the NAV did.
    mode: p.full_exit_units ? "FULL" : "AMOUNT",
    amount: p.id === preselect && p.yet_to_advise_amount > 0 ? String(Math.round(p.yet_to_advise_amount)) : "",
    units: "",
    price: p.security_id && navOf.get(p.security_id) ? String(navOf.get(p.security_id)) : "",
  });
  const [edited, setRows] = useState<Record<string, PlanRow>>(() => Object.fromEntries(planItems.map((p) => [p.id, initialRow(p)])));
  // Every visible line has a row, even one that came in with new props (e.g. switching SELL → ALL).
  const rows: Record<string, PlanRow> = Object.fromEntries(visible.map((p) => [p.id, edited[p.id] ?? initialRow(p)]));
  const [off, setOff] = useState<OffRow[]>([]);
  const [sipStops, setSipStops] = useState<RunningSip[]>([]);
  const [confirmOver, setConfirmOver] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [portfolioOpen, setPortfolioOpen] = useState(false);
  const [pickFunds, setPickFunds] = useState<Record<string, boolean>>({});
  const [pickSips, setPickSips] = useState<Record<string, boolean>>({});

  const setRow = (id: string, patch: Partial<PlanRow>) => setRows((r) => ({ ...r, [id]: { ...rows[id], ...r[id], ...patch, include: patch.include ?? true } }));
  const setMany = (ids: string[], patch: (p: AdvisablePlanItem) => Partial<PlanRow> | null) => setRows((r) => {
    const next = { ...r };
    for (const p of visible) {
      if (!ids.includes(p.id)) continue;
      const change = patch(p);
      if (change) next[p.id] = { ...rows[p.id], ...r[p.id], ...change };
    }
    return next;
  });

  /** A plan line as the call it records. */
  const planCall = (p: AdvisablePlanItem, r: PlanRow) => {
    const nav = num(r.price) || (p.security_id ? navOf.get(p.security_id) ?? 0 : 0);
    if (r.mode === "FULL" && p.side === "SELL") {
      const units = fullUnits(p);
      return { basis: "UNITS" as const, units, amount: units * nav || p.yet_to_advise_amount, nav };
    }
    if (r.mode === "FULL") return { basis: "AMOUNT" as const, units: null, amount: p.yet_to_advise_amount, nav };
    if (r.mode === "UNITS") {
      const units = num(r.units) || 0;
      // Plan lines in Units have no ₹ box: the estimate is units × NAV (a ₹ typed before switching does not count).
      return { basis: "UNITS" as const, units: units || null, amount: units * nav, nav };
    }
    return { basis: "AMOUNT" as const, units: null, amount: num(r.amount) || 0, nav };
  };
  const offCall = (o: OffRow) => {
    const sec = secOf(o.fund?.value);
    const nav = num(o.price) || 0;
    if (o.mode === "FULL" && o.action === "SELL" && sec) {
      const units = unitsOf.get(sec) ?? 0;
      return { basis: "UNITS" as const, units, amount: units * nav, nav };
    }
    if (o.mode === "UNITS") {
      const units = num(o.units) || 0;
      return { basis: "UNITS" as const, units: units || null, amount: num(o.amount) || units * nav, nav };
    }
    return { basis: "AMOUNT" as const, units: null, amount: num(o.amount) || 0, nav };
  };

  const chosen = visible.filter((p) => rows[p.id]?.include);
  const items = [
    ...chosen.map((p) => {
      const c = planCall(p, rows[p.id]);
      return {
        plan_item_id: p.id, security_id: p.security_id, action: p.action === "BUY" ? "BUY" : "SELL", quantity_basis: c.basis,
        advised_amount: Math.round(c.amount * 100) / 100, advised_units: c.basis === "UNITS" ? c.units : null,
        reference_price: c.nav || null, valid_until: null,
      };
    }),
    ...off.map((o) => {
      const c = offCall(o);
      return {
        plan_item_id: null, security_id: o.fund?.value ?? null, action: o.action, quantity_basis: c.basis,
        advised_amount: Math.round(c.amount * 100) / 100, advised_units: c.basis === "UNITS" ? c.units : null,
        reference_price: c.nav || null, valid_until: null,
      };
    }),
  ];
  const isPlannedExit = (p: AdvisablePlanItem) => p.side === "SELL" && Boolean(p.full_exit_units) && rows[p.id].mode === "FULL";
  const overAdvised = chosen.filter((p) => !isPlannedExit(p) && planCall(p, rows[p.id]).amount > p.yet_to_advise_amount + 1);
  // Selected lines with nothing to record yet (e.g. after "Select all"): caught here, not as a server error.
  const missing = items.filter((i) => !(i.advised_amount > 0)).length;
  const total = (s: string) => items.filter((i) => (s === "BUY" ? i.action === "BUY" : i.action !== "BUY")).reduce((t, i) => t + (i.advised_amount || 0), 0);
  const fullExits = chosen.filter((p) => p.side === "SELL" && rows[p.id].mode === "FULL").length + off.filter((o) => o.action === "SELL" && o.mode === "FULL").length;
  const sells = visible.filter((p) => p.side === "SELL");
  const buys = visible.filter((p) => p.side === "BUY");

  function openPortfolio() {
    setPickFunds(Object.fromEntries(funds.map((f) => [f.security_id, true])));
    setPickSips(Object.fromEntries(runningSips.map((s) => [s.security_id, true])));
    setPortfolioOpen(true);
  }
  function applyPortfolio() {
    const ids = funds.filter((f) => pickFunds[f.security_id]).map((f) => f.security_id);
    const viaPlan = new Set<string>();
    const planIds: string[] = [];
    for (const p of sells) {
      if (p.security_id && ids.includes(p.security_id) && !viaPlan.has(p.security_id)) {
        viaPlan.add(p.security_id);
        planIds.push(p.id);
      }
    }
    setMany(planIds, () => ({ include: true, mode: "FULL" }));
    const already = new Set(off.map((o) => secOf(o.fund?.value)).filter(Boolean));
    const extra: OffRow[] = funds
      .filter((f) => ids.includes(f.security_id) && !viaPlan.has(f.security_id) && !already.has(f.security_id))
      .map((f, i) => ({ key: Date.now() + i, fund: { value: `sec:${f.security_id}`, scheme_name: f.scheme_name, nav: f.nav }, action: "SELL", mode: "FULL", amount: "", units: "", price: f.nav ? String(f.nav) : "" }));
    setOff((o) => [...o.map((x) => (ids.includes(secOf(x.fund?.value) ?? "") && x.action === "SELL" ? { ...x, mode: "FULL" as Mode } : x)), ...extra]);
    setSipStops(runningSips.filter((s) => pickSips[s.security_id]));
    setPortfolioOpen(false);
  }
  const pickedTotal = funds.filter((f) => pickFunds[f.security_id]).reduce((t, f) => t + f.value, 0);

  const section = (title: string, list: AdvisablePlanItem[], tone: "sell" | "buy") => (
    <div className="overflow-hidden rounded-xl border border-border bg-white">
      <div className={cn("flex items-center justify-between gap-2 border-b border-border px-4 py-2", tone === "sell" ? "bg-red-50" : "bg-blue-50")}>
        <span className={cn("text-sm font-semibold", tone === "sell" ? "text-red-900" : "text-blue-900")}>{title} · {list.length} line{list.length === 1 ? "" : "s"} from the plan</span>
        <span className={cn("text-xs", tone === "sell" ? "text-red-900" : "text-blue-900")}>
          {list.filter((p) => rows[p.id]?.include).length} selected · {formatINRCompact(list.filter((p) => rows[p.id]?.include).reduce((t, p) => t + planCall(p, rows[p.id]).amount, 0))}
        </span>
      </div>
      <div className="hidden grid-cols-[28px_minmax(0,2.3fr)_96px_minmax(0,2.6fr)_110px] gap-x-3 border-b border-slate-100 px-4 py-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-muted md:grid">
        <span /><span>Fund</span><span className="text-right">Left</span><span>How much</span><span className="text-right">≈ Value</span>
      </div>
      <ul className="divide-y divide-slate-100">
        {list.map((p) => {
          const r = rows[p.id];
          const c = planCall(p, r);
          const units = held(p);
          return (
            <li key={p.id} className={cn("grid items-center gap-x-3 gap-y-2 px-4 py-2.5 md:grid-cols-[28px_minmax(0,2.3fr)_96px_minmax(0,2.6fr)_110px]", r.include && (tone === "sell" ? "bg-red-50/30" : "bg-blue-50/30"))}>
              <input type="checkbox" checked={r.include} onChange={(e) => setRow(p.id, { include: e.target.checked })} aria-label={`Select ${p.scheme_name}`} className="h-4 w-4" />
              <div className="min-w-0">
                <div className="truncate text-[13.5px] font-medium" title={p.scheme_name}>{p.scheme_name}</div>
                <div className="text-[11.5px] text-muted">
                  {units > 0 ? `holds ${formatUnits(units)} units` : p.side === "BUY" ? "new fund" : "not in the latest CAS"}
                  {p.security_id && navOf.get(p.security_id) ? ` · NAV ${navOf.get(p.security_id)}` : ""}
                </div>
              </div>
              <div className="text-right text-[13.5px] font-semibold num">{formatINRCompact(p.yet_to_advise_amount)}</div>
              <div className="flex items-center gap-2">
                <ModeSwitch mode={r.mode} full={canFull(p)} units={p.side === "SELL"}
                  fullTitle={p.side === "SELL" ? (fullUnits(p) > 0 ? `Full redemption: all ${formatUnits(fullUnits(p))} units` : "No units in the latest CAS") : "Full buy: all left to advise"}
                  onChange={(m) => setRow(p.id, { mode: m, include: true })} />
                {r.mode === "FULL" ? (
                  <span className="flex h-8 min-w-0 flex-1 items-center truncate rounded-md bg-slate-100 px-2.5 text-xs text-slate-700">
                    {p.side === "SELL" ? `${formatUnits(fullUnits(p))} units (all)` : `${formatINR(p.yet_to_advise_amount)} (all left)`}
                  </span>
                ) : r.mode === "UNITS" ? (
                  <>
                    <Input className="h-8 min-w-0 flex-1 text-xs" inputMode="decimal" placeholder="Units" value={r.units} aria-label="Units" onChange={(e) => setRow(p.id, { units: e.target.value })} />
                    <Input className="h-8 w-20 text-xs" inputMode="decimal" placeholder="NAV" value={r.price} aria-label="Reference NAV" onChange={(e) => setRow(p.id, { price: e.target.value })} />
                  </>
                ) : (
                  <Input className="h-8 min-w-0 flex-1 text-xs" inputMode="decimal" placeholder="₹ amount" value={r.amount} aria-label="Amount in rupees" onChange={(e) => setRow(p.id, { amount: e.target.value })} />
                )}
              </div>
              <div className={cn("text-right text-[13.5px] font-semibold num", tone === "sell" ? "text-red-700" : "text-blue-700")}>
                {r.include && c.amount > 0 ? `${c.basis === "UNITS" ? "≈ " : ""}${formatINRCompact(c.amount)}` : r.include ? <span className="text-[11px] font-normal text-amber-700">{r.mode === "UNITS" && c.units ? "add NAV" : "add amount"}</span> : "—"}
                {r.include && !isPlannedExit(p) && c.amount > p.yet_to_advise_amount + 1 ? <div className="text-[10px] font-normal text-red-700">more than left</div> : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );

  return (
    <form action={formAction} className="space-y-4 pb-24">
      <input type="hidden" name="items" value={JSON.stringify(items)} />
      <input type="hidden" name="sip_stops" value={JSON.stringify(sipStops)} />
      {queue ? <><input type="hidden" name="queue_next" value={queue.next.join(",")} /><input type="hidden" name="queue_done" value={queue.done} /><input type="hidden" name="queue_skipped" value={queue.skipped} /></> : null}
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Told at (IST) *" className="w-56">
          <Input type="datetime-local" name="communicated_at" defaultValue={queue?.at || toISTDateTimeLocal()} required />
        </Field>
        <Field label="Channel *" className="w-40">
          <Select name="channel" defaultValue={queue?.channel && (CHANNELS as readonly string[]).includes(queue.channel) ? queue.channel : "PHONE"}>{CHANNELS.map((c) => <option key={c} value={c}>{c.replace("_", " ")}</option>)}</Select>
        </Field>
        {advisors?.length ? (
          <Field label="Advisor (admin may record on behalf)" className="w-56">
            <Select name="advisor_id" defaultValue="">{[<option key="me" value="">Me</option>, ...advisors.map((a) => <option key={a.id} value={a.id}>{a.full_name}</option>)]}</Select>
          </Field>
        ) : null}
        {showNotes ? null : <Button type="button" variant="outline" onClick={() => setShowNotes(true)}>+ Note</Button>}
        <span className="pb-2 text-[11.5px] text-muted">{queue ? "Kept for every client in this round; change it here if needed." : "The exact time the client was told; fixed once saved."}</span>
      </div>
      {showNotes ? <Field label="Notes"><Textarea name="notes" rows={2} placeholder="What was said, market context…" /></Field> : null}

      {/* Select many, then Full on all of them; or the whole portfolio. */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-white px-3 py-2">
        <span className="text-xs text-muted">Select</span>
        {([["All", visible], ["Sells", sells], ["Buys", buys]] as const).map(([label, list]) => (
          <button key={label} type="button" disabled={!list.length}
            onClick={() => setMany(list.map((p) => p.id), () => ({ include: true }))}
            className="h-8 rounded-full border border-border px-3 text-xs hover:bg-slate-50 disabled:opacity-40">{label}</button>
        ))}
        <button type="button" onClick={() => setMany(visible.map((p) => p.id), () => ({ include: false }))} className="h-8 rounded-full border border-border px-3 text-xs hover:bg-slate-50">None</button>
        <span className="mx-1 h-6 w-px bg-border" aria-hidden />
        <Button type="button" size="sm" disabled={!chosen.some(canFull)}
          onClick={() => setMany(chosen.map((p) => p.id), (p) => (canFull(p) ? { mode: "FULL" } : null))}>
          Full on {chosen.filter(canFull).length} selected
        </Button>
        <span className="text-[11.5px] text-muted">Sells: all units · Buys: all left to advise</span>
        <span className="flex-1" />
        {side !== "BUY" && funds.length ? (
          <Button type="button" size="sm" variant="outline" className="border-red-300 text-red-700 hover:bg-red-50" onClick={openPortfolio}>Full portfolio redemption…</Button>
        ) : null}
      </div>

      {visible.length === 0 ? (
        <p className="rounded-xl border border-border bg-white p-3 text-sm text-muted">No open plan lines{side !== "ALL" ? ` on the ${side.toLowerCase()} side` : ""}. Use an off-plan call below if needed.</p>
      ) : null}
      {sells.length ? section("Sell", sells, "sell") : null}
      {buys.length ? section("Buy", buys, "buy") : null}

      <div className="rounded-xl border border-border bg-white">
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <span className="text-sm font-semibold">Off-plan calls{off.length ? ` · ${off.length}` : ""}</span>
          <Button type="button" size="sm" variant="outline" onClick={() => setOff((o) => [...o, { key: Date.now(), fund: null, action: side === "BUY" ? "BUY" : "SELL", mode: "AMOUNT", amount: "", units: "", price: "" }])}>+ Add off-plan call</Button>
        </div>
        {off.length === 0 ? <p className="px-4 py-3 text-xs text-muted">For any fund outside the approved plan: search all mutual funds by name, AMC or ISIN. Tracked like every call, but not counted against plan targets.</p> : (
          <div className="space-y-2 p-3">
            {off.map((o, idx) => {
              const upd = (patch: Partial<OffRow>) => setOff((all) => all.map((x, i) => (i === idx ? { ...x, ...patch } : x)));
              const sec = secOf(o.fund?.value);
              const units = sec ? unitsOf.get(sec) ?? 0 : 0;
              const c = offCall(o);
              return (
                <div key={o.key} className="flex flex-wrap items-center gap-2">
                  <FundPicker
                    className="w-96"
                    search={searchFunds}
                    value={o.fund}
                    onChange={(f) => upd({ fund: f, price: f?.nav ? String(f.nav) : o.price, mode: o.mode === "FULL" ? "AMOUNT" : o.mode })}
                    suggestions={holdings.map((h) => ({ value: `sec:${h.security_id}`, scheme_name: h.scheme_name, nav: h.nav, note: `holds ${h.units.toFixed(3)} units${h.folio ? ` · folio ${h.folio}` : ""}` }))}
                  />
                  <Select className="h-8 w-24 text-xs" value={o.action} aria-label="Buy or sell" onChange={(e) => upd({ action: e.target.value as OffRow["action"], mode: o.mode === "FULL" ? "AMOUNT" : o.mode })}><option>SELL</option><option>BUY</option></Select>
                  <ModeSwitch mode={o.mode} full={o.action === "SELL" && units > 0}
                    fullTitle={o.action === "SELL" ? (units > 0 ? `Full redemption: all ${formatUnits(units)} units` : "Pick a fund the client holds") : "Full applies to sells of a held fund"}
                    onChange={(m) => upd({ mode: m })} />
                  {o.mode === "FULL" ? (
                    <span className="flex h-8 items-center rounded-md bg-slate-100 px-2.5 text-xs text-slate-700">{formatUnits(units)} units (all)</span>
                  ) : (
                    <>
                      <Input className="h-8 w-28 text-xs" placeholder="Amount ₹" aria-label="Amount in rupees" value={o.amount} onChange={(e) => upd({ amount: e.target.value })} />
                      {o.mode === "UNITS" ? <Input className="h-8 w-24 text-xs" placeholder="Units" aria-label="Units" value={o.units} onChange={(e) => upd({ units: e.target.value })} /> : null}
                    </>
                  )}
                  <Input className="h-8 w-20 text-xs" placeholder="NAV" aria-label="Reference NAV" value={o.price} onChange={(e) => upd({ price: e.target.value })} />
                  <span className="w-24 text-right text-xs font-semibold num">{c.amount > 0 ? `${c.basis === "UNITS" ? "≈ " : ""}${formatINRCompact(c.amount)}` : ""}</span>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setOff((all) => all.filter((_, i) => i !== idx))}>Remove</Button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {sipStops.length ? (
        <div className="rounded-xl border border-violet-200 bg-violet-50 px-4 py-3">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-violet-800">SIP · kept apart from Buy &amp; Sell</div>
          <ul className="space-y-1 text-[13px]">
            {sipStops.map((s) => (
              <li key={s.security_id} className="flex items-center justify-between gap-2">
                <span><b>Stop SIP</b> · {s.scheme_name} · {formatINR(s.amount)}/month</span>
                <button type="button" className="text-xs text-violet-800 hover:underline" onClick={() => setSipStops((all) => all.filter((x) => x.security_id !== s.security_id))}>Remove</button>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11.5px] text-violet-900">Recorded as Stop SIP lines on the plan, advised now; the next CAS shows them done.</p>
        </div>
      ) : null}

      {state && !state.ok ? <p role="alert" className="whitespace-pre-line rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{state.error}</p> : null}

      <div className="sticky bottom-3 z-20 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-ink px-4 py-3 text-white shadow-lg">
        <div className="text-sm">
          <b>{items.length}</b> call{items.length === 1 ? "" : "s"} · <span className="font-semibold text-red-300">Sell {formatINR(total("SELL"))}</span>
          {fullExits ? <span className="text-slate-300"> ({fullExits} full exit{fullExits === 1 ? "" : "s"} in units)</span> : null}
          {" · "}<span className="font-semibold text-blue-300">Buy {formatINR(total("BUY"))}</span>
          {sipStops.length ? <span className="text-violet-200"> · {sipStops.length} SIP stop{sipStops.length === 1 ? "" : "s"}</span> : null}
          {cash != null && items.length ? (
            // Money check: cash in bank, plus what these sells bring, minus what these buys need.
            <div className="text-xs text-slate-300">
              Cash {formatINRCompact(cash)} + sells ≈ {formatINRCompact(total("SELL"))} − buys {formatINRCompact(total("BUY"))} = {cash + total("SELL") - total("BUY") < -0.5
                ? <b className="text-amber-300">short by ≈ {formatINRCompact(total("BUY") - cash - total("SELL"))}</b>
                : <b className="text-emerald-300">≈ {formatINRCompact(cash + total("SELL") - total("BUY"))} left</b>}
              {total("BUY") > cash + 0.5 && total("SELL") >= 0.5 ? " · the buys need the sell money: buy once the redemption lands" : ""}
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {overAdvised.length ? (
            <label className="flex items-center gap-1.5 text-xs text-amber-200">
              <input type="checkbox" checked={confirmOver} onChange={(e) => setConfirmOver(e.target.checked)} /> {overAdvised.length} line(s) advise more than the plan has left: I mean it
            </label>
          ) : null}
          {queue ? <a href={queue.skipHref} className="text-sm text-slate-300 hover:text-white hover:underline">{queue.nextName ? "Skip" : "Skip, end the round"}</a> : null}
          {missing ? <span className="text-xs text-amber-200">{missing} selected line{missing === 1 ? " has" : "s have"} no amount yet</span> : null}
          <button type="submit" disabled={pending || (items.length === 0 && sipStops.length === 0) || missing > 0 || (overAdvised.length > 0 && !confirmOver)}
            className="h-10 rounded-lg bg-white px-5 text-sm font-bold text-ink disabled:opacity-50">
            {pending ? "Recording…" : queue
              ? `Record ${items.length || ""} & ${queue.nextName ? `next: ${queue.nextName} →` : "finish the round"}`
              : items.length ? `Record ${items.length} call${items.length === 1 ? "" : "s"}${sipStops.length ? " + SIP stops" : ""} as given` : sipStops.length ? "Record the SIP stops as given" : "Record calls as given"}
          </button>
        </div>
      </div>

      {portfolioOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" role="dialog" aria-modal="true" aria-labelledby="fpr-title"
          onKeyDown={(e) => { if (e.key === "Escape") setPortfolioOpen(false); }}>
          <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
            <div className="border-b border-border px-6 py-4">
              <div className="text-[11px] font-bold uppercase tracking-wider text-red-700">Full portfolio redemption</div>
              <h2 id="fpr-title" className="mt-0.5 text-lg font-semibold">Exit everything the client holds?</h2>
              <p className="text-sm text-muted">Every fund in the latest CAS, in all units{runningSips.length ? ", plus a Stop SIP line for each running SIP" : ""}. Untick anything to keep.</p>
            </div>
            <div className="overflow-y-auto px-6 py-2">
              <ul className="divide-y divide-slate-100">
                {funds.map((f) => {
                  const viaPlan = sells.some((p) => p.security_id === f.security_id);
                  return (
                    <li key={f.security_id}>
                      <label className="grid cursor-pointer grid-cols-[24px_minmax(0,1fr)_130px_100px] items-center gap-2 py-2 text-[13.5px]">
                        <input type="checkbox" checked={Boolean(pickFunds[f.security_id])} onChange={(e) => setPickFunds((x) => ({ ...x, [f.security_id]: e.target.checked }))} className="h-4 w-4" />
                        <span className="min-w-0 truncate"><b className="font-semibold">{f.scheme_name}</b>{" "}
                          <span className={cn("rounded-full px-2 py-px text-[11px] font-semibold", viaPlan ? "bg-indigo-50 text-indigo-800" : "bg-slate-100 text-slate-700")}>{viaPlan ? "plan line" : "off-plan"}</span>
                        </span>
                        <span className="text-right num">{formatUnits(f.units)}</span>
                        <span className="text-right font-semibold text-red-700 num">{f.value ? formatINRCompact(f.value) : "—"}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
              {runningSips.length ? (
                <div className="my-3 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2">
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-violet-800">SIPs · kept apart from Buy &amp; Sell</div>
                  {runningSips.map((s) => (
                    <label key={s.security_id} className="flex cursor-pointer items-center gap-2 py-0.5 text-[13px]">
                      <input type="checkbox" checked={Boolean(pickSips[s.security_id])} onChange={(e) => setPickSips((x) => ({ ...x, [s.security_id]: e.target.checked }))} className="h-4 w-4" />
                      <span><b>Stop SIP</b> · {s.scheme_name} · {formatINR(s.amount)}/month</span>
                    </label>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-slate-50 px-6 py-3">
              <div className="text-sm">
                {funds.filter((f) => pickFunds[f.security_id]).length} full exit(s) · <b className="text-red-700">≈ {formatINRCompact(pickedTotal)}</b>
                {runningSips.length ? ` · ${runningSips.filter((s) => pickSips[s.security_id]).length} SIP(s) stopped` : ""}
                <div className="text-[11.5px] text-muted">Added to the calls below; nothing is recorded until you press Record.</div>
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={() => setPortfolioOpen(false)}>Cancel</Button>
                <Button type="button" variant="danger" onClick={applyPortfolio}>Add to the calls</Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </form>
  );
}
