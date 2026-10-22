"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Check } from "lucide-react";
import { formatDate, formatINRCompact, formatUnits } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ActionResult } from "@/lib/actions";
import type { ApprovedRow, ApproveLine, WaitingSip } from "@/services/waiting-approve";
import type { WaitingCall } from "@/services/waiting";

type Kind = "CALL" | "SIP";
interface Row { kind: Kind; id: string; call?: WaitingCall; sip?: WaitingSip }
interface Choice { choice: string; amount: string; units: string; date: string; reason: string }

const CALL_CHOICES = [["DONE", "✓ Done"], ["PART", "◐ Part done"], ["REVISE", "✎ Revise"], ["CANCEL", "✕ Cancel"]] as const;
const SIP_CHOICES = [["STARTED", "✓ Started"], ["CANCEL", "✕ Cancel"]] as const;
const TONE: Record<string, string> = { DONE: "text-emerald-700", STARTED: "text-emerald-700", PART: "text-amber-700", REVISE: "text-brand", CANCEL: "text-red-700" };
const REASONS = ["Client's choice", "Client declined", "Fund changed", "Market moved", "Amount changed"];
const L = (v: number) => formatINRCompact(v);
const side = (a: string) => (a === "BUY" ? <b className="text-[11px] text-blue-700">BUY</b> : a === "START" || a === "STOP" || a === "CHANGE" ? <b className="text-[11px] text-violet-700">SIP</b> : <b className="text-[11px] text-red-700">{a === "SELL" ? "SELL" : a}</b>);

function known(c: WaitingCall): string {
  if (c.to_confirm) return "The CAS seems to show it: one click in the CAS inbox";
  if (c.done_on) return `Part recorded (${formatDate(c.done_on)})`;
  if (c.cas_after) return `The CAS of ${formatDate(c.cas_after)} does not show it`;
  return `Not in a CAS yet · ${c.age_days} day${c.age_days === 1 ? "" : "s"}`;
}

function advisedText(c: WaitingCall): string {
  const units = c.quantity_basis === "UNITS" && c.pending_units != null ? `${formatUnits(c.pending_units)} units · ≈${L(c.pending_amount)}` : `₹${Math.round(c.pending_amount).toLocaleString("en-IN")}`;
  const left = c.executed_amount > 0.5 ? " left" : "";
  return `${units}${left} · ${formatDate(c.communicated_at)}`;
}

/**
 * Approve waiting: every waiting call and SIP line of the client, one line each. Pick what
 * happened (Done / Part done / Revise / Cancel), tick, approve many at once. Nothing is saved
 * until Approve; an approved line can be undone until a CAS shows it.
 */
export function ApproveWaiting({ clientId, calls, sips, approved, canApprove, today, approve, undo }: {
  clientId: string;
  calls: WaitingCall[];
  sips: WaitingSip[];
  approved: ApprovedRow[];
  canApprove: boolean;
  today: string;
  approve: (lines: ApproveLine[]) => Promise<ActionResult & { failed?: { id: string; error: string }[] }>;
  undo: (kind: Kind, id: string) => Promise<ActionResult>;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const rows: Row[] = [...calls.map((c) => ({ kind: "CALL" as const, id: c.advice_item_id, call: c })), ...sips.map((s) => ({ kind: "SIP" as const, id: s.id, sip: s }))];
  const [choice, setChoice] = useState<Record<string, Choice>>(() =>
    Object.fromEntries(rows.map((r) => [r.id, { choice: r.kind === "SIP" ? "STARTED" : "DONE", amount: "", units: "", date: today, reason: "" }])));
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [bulkDate, setBulkDate] = useState(today);

  const set = (id: string, patch: Partial<Choice>) => setChoice((s) => ({ ...s, [id]: { ...s[id], ...patch } }));
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allPicked = rows.length > 0 && rows.every((r) => picked.has(r.id));

  function approveSelected() {
    setMsg(null);
    const lines: ApproveLine[] = rows.filter((r) => picked.has(r.id)).map((r) => ({ kind: r.kind, id: r.id, ...choice[r.id] }));
    if (!lines.length) { setMsg({ ok: false, text: "Tick the lines to approve." }); return; }
    start(async () => {
      const res = await approve(lines);
      const failed = Object.fromEntries((res.failed ?? []).map((f) => [f.id, f.error]));
      setErrors(failed);
      setPicked(new Set(Object.keys(failed)));
      if (res.ok) {
        // Back to the client's Tranches & SIPs with the statuses updated.
        router.push(`/clients/${clientId}?tab=tranches&approved=${lines.length}#ledger`);
        return;
      }
      setMsg({ ok: false, text: res.error });
      router.refresh();
    });
  }
  function undoOne(kind: Kind, id: string) {
    start(async () => {
      const res = await undo(kind, id);
      setMsg(res.ok ? { ok: true, text: res.message ?? "Undone." } : { ok: false, text: res.error });
      router.refresh();
    });
  }

  const cols = "grid-cols-[22px_minmax(200px,1.4fr)_minmax(150px,1fr)_130px_150px_minmax(200px,1.2fr)]";
  return (
    <div className="space-y-4">
      <section className="overflow-hidden rounded-xl border border-border bg-surface">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
          <h3 className="text-[15px] font-semibold">Waiting calls and SIPs</h3>
          <span className="text-xs text-muted">{rows.length ? `${rows.length} waiting · nothing changes until you press Approve` : "nothing is waiting"}</span>
        </div>

        {canApprove && rows.length ? (
          <div className="flex flex-wrap items-center gap-2.5 border-t border-brand-100 bg-brand-50/60 px-4 py-2 text-[13px]">
            <b className="text-brand-800">{picked.size} selected</b>
            <button type="button" onClick={approveSelected} disabled={pending || !picked.size}
              className="inline-flex items-center gap-1 rounded-md bg-emerald-700 px-3 py-1.5 font-semibold text-white hover:bg-emerald-800 disabled:opacity-50">
              <Check className="h-3.5 w-3.5" /> {pending ? "Saving…" : `Approve ${picked.size || ""}`.trim()}
            </button>
            <span className="flex items-center gap-1.5">
              <input type="date" value={bulkDate} max={today} onChange={(e) => setBulkDate(e.target.value)} aria-label="Date for the selected lines"
                className="h-8 rounded-md border border-border bg-white px-2 text-[12.5px]" />
              <button type="button" disabled={!picked.size} onClick={() => setChoice((s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, picked.has(k) ? { ...v, date: bulkDate } : v])))}
                className="rounded-md bg-white px-3 py-1.5 font-semibold ring-1 ring-border hover:bg-slate-50 disabled:opacity-50">Set date for selected</button>
            </span>
            <span className="text-muted">Each line: Done · Part done · Revise · Cancel. Lines you don&apos;t tick stay waiting.</span>
          </div>
        ) : null}
        {msg ? <p role="status" className={cn("border-t border-border px-4 py-2 text-[13px]", msg.ok ? "text-emerald-800" : "text-red-700")}>{msg.text}</p> : null}

        {rows.length ? (
          <div className="overflow-x-auto border-t border-border">
            <div className="min-w-[1000px] text-[13px]">
              <div className={cn("grid items-center gap-2.5 bg-slate-50 px-4 py-2 text-[10.5px] font-semibold uppercase tracking-wide text-muted", cols)}>
                <span>{canApprove ? <input type="checkbox" checked={allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set(rows.map((r) => r.id)))} aria-label="Select all" className="h-4 w-4 accent-brand" /> : null}</span>
                <span>Call · what we advised</span><span>What we know</span><span>What happened</span><span>Amount · units</span><span>Date · reason</span>
              </div>
              {rows.map((r) => {
                const ch = choice[r.id];
                const err = errors[r.id];
                const isPicked = picked.has(r.id);
                const c = r.call;
                const unitsCall = c?.quantity_basis === "UNITS";
                const needsReason = ch.choice === "REVISE" || ch.choice === "CANCEL";
                const field = "h-8 w-full rounded-md border border-border bg-white px-2 text-[12.5px] num disabled:bg-slate-50";
                return (
                  <div key={r.id} className={cn("border-t border-slate-100", err ? "bg-red-50/60" : isPicked ? "bg-brand-50/50" : ch.choice === "CANCEL" ? "bg-red-50/30" : "")}>
                    <div className={cn("grid items-start gap-2.5 px-4 py-2.5", cols)}>
                      <span className="pt-1.5">{canApprove ? <input type="checkbox" checked={isPicked} onChange={() => toggle(r.id)} aria-label="Select line" className="h-4 w-4 accent-brand" /> : null}</span>
                      <div className="min-w-0">
                        <div className="truncate">{side(c ? c.action : r.sip!.action)} <b>{c ? c.scheme_name : r.sip!.scheme_name}</b></div>
                        <div className="text-[12px] text-muted">
                          {c ? <><Link href={`/advice/items/${c.advice_item_id}`} className="hover:underline">{advisedText(c)}</Link></>
                            : `${r.sip!.action === "START" ? "Start" : r.sip!.action === "STOP" ? "Stop" : "Change"} ${r.sip!.new_amount ? `₹${Math.round(r.sip!.new_amount).toLocaleString("en-IN")} / month` : r.sip!.old_amount ? `₹${Math.round(r.sip!.old_amount).toLocaleString("en-IN")} / month` : ""}${r.sip!.advised_at ? ` · ${formatDate(r.sip!.advised_at)}` : ""}`}
                        </div>
                      </div>
                      <div className="pt-1 text-[12.5px] text-slate-600">{c ? known(c) : "Not in a CAS yet"}</div>
                      <div>
                        <select value={ch.choice} disabled={!canApprove} onChange={(e) => set(r.id, { choice: e.target.value })} aria-label="What happened"
                          className={cn("h-8 w-full rounded-md border border-border bg-white px-1.5 text-[12.5px] font-semibold", TONE[ch.choice])}>
                          {(r.kind === "SIP" ? SIP_CHOICES : CALL_CHOICES).map(([v, t]) => <option key={v} value={v}>{t}</option>)}
                        </select>
                      </div>
                      <div className="space-y-1">
                        {r.kind === "CALL" && ch.choice !== "CANCEL" ? (
                          <>
                            {!(unitsCall && ch.choice === "REVISE") ? (
                              <input value={ch.amount} disabled={!canApprove} onChange={(e) => set(r.id, { amount: e.target.value })} inputMode="decimal"
                                placeholder={ch.choice === "REVISE" ? "new amount ₹" : `₹ ${Math.round(c!.pending_amount).toLocaleString("en-IN")}`} aria-label="Amount" className={field} />
                            ) : null}
                            {unitsCall ? (
                              ch.choice === "DONE"
                                ? <div className="px-1 text-[12px] text-muted">{formatUnits(c!.pending_units ?? 0)} units</div>
                                : <input value={ch.units} disabled={!canApprove} onChange={(e) => set(r.id, { units: e.target.value })} inputMode="decimal"
                                    placeholder={ch.choice === "REVISE" ? "new total units" : "units done"} aria-label="Units" className={field} />
                            ) : null}
                          </>
                        ) : <span className="px-1 text-[12px] text-muted">—</span>}
                      </div>
                      <div className="space-y-1">
                        {needsReason ? (
                          <>
                            <input value={ch.reason} disabled={!canApprove} onChange={(e) => set(r.id, { reason: e.target.value })} list="waiting-reasons"
                              placeholder="Reason (required)" aria-label="Reason" className={field} />
                            <div className="text-[12px] text-slate-600">{ch.choice === "CANCEL" ? "Call closed · the rest goes back to left to advise" : "A new call replaces it · the difference goes back to left to advise"}</div>
                          </>
                        ) : (
                          <>
                            <input type="date" value={ch.date} max={today} disabled={!canApprove} onChange={(e) => set(r.id, { date: e.target.value })} aria-label="Date done"
                              className={field} />
                            <div className="text-[12px] text-slate-600">{ch.choice === "PART" ? "The rest stays waiting on the call" : r.kind === "SIP" ? "Counted as running" : "Counts in the money now · waiting for CAS"}</div>
                          </>
                        )}
                      </div>
                    </div>
                    {err ? <p className="px-4 pb-2 pl-[52px] text-[12px] text-red-700">{err}</p> : null}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <p className="border-t border-border px-4 py-4 text-sm text-muted">No calls or SIPs are waiting for this client.</p>
        )}
        <datalist id="waiting-reasons">{REASONS.map((r) => <option key={r} value={r} />)}</datalist>
      </section>

      {approved.length ? (
        <section className="overflow-hidden rounded-xl border border-border bg-surface">
          <div className="flex flex-wrap items-center gap-x-3 px-4 py-3">
            <h3 className="text-[15px] font-semibold">Approved, waiting for CAS</h3>
            <span className="text-xs text-muted">counted in the money now; the next CAS confirms them. Undo puts a line back to waiting.</span>
          </div>
          <ul className="divide-y divide-slate-100 border-t border-border text-[13px]">
            {approved.map((a) => (
              <li key={`${a.kind}${a.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
                <span>{side(a.action)} <b>{a.scheme_name}</b></span>
                <span className="num text-slate-600">
                  {a.kind === "SIP" ? `${a.amount ? `₹${Math.round(a.amount).toLocaleString("en-IN")} / month` : ""} started` : `${a.amount ? L(a.amount) : ""}${a.units ? ` · ${formatUnits(a.units)} units` : ""}`}
                  {a.date ? ` · ${formatDate(a.date)}` : ""}
                </span>
                <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-800">Approved · waiting for CAS</span>
                {canApprove && a.undoable ? (
                  <button type="button" onClick={() => undoOne(a.kind, a.id)} disabled={pending} className="ml-auto text-[12px] text-brand hover:underline disabled:opacity-50">Undo</button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
