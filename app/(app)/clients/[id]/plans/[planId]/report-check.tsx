"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { Check, X } from "lucide-react";
import { checkLine, approvalNote, type CheckAction } from "@/lib/domain/report-check";
import { formatINRCompact } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ActionResult } from "@/lib/actions";
import type { ReportQuestionRow } from "@/services/plans";
import type { CheckAnswer } from "../actions";

const ACT: Record<CheckAction, string> = { SELL: "Sell", BUY: "Buy", RETAIN: "Keep" };
const TONE: Record<CheckAction, string> = { SELL: "text-red-700", BUY: "text-blue-700", RETAIN: "text-slate-700" };
type Filter = "all" | "SELL" | "BUY" | "RETAIN" | "none";

/**
 * The report check: one line per difference between the report and the CAS. Each line says what
 * the report says, what the CAS shows, the issue and a possible fix; "Your choice" starts as what
 * the report says. Tick lines and approve them together: nothing to type, no Save per fund.
 */
export function ReportCheck({
  rows, canAnswer, draft, title, approve, reopen,
}: {
  rows: ReportQuestionRow[];
  canAnswer: boolean;
  /** Answers can be undone while the plan is a draft. */
  draft: boolean;
  title?: string;
  approve: (answers: CheckAnswer[]) => Promise<ActionResult & { failed?: { itemId: string; error: string }[] }>;
  reopen: (itemId: string) => Promise<ActionResult>;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const lines = useMemo(() => rows.map((r) => ({ r, l: checkLine(r) })), [rows]);
  const [choice, setChoice] = useState<Record<string, { action: CheckAction | null; size: string }>>(() =>
    Object.fromEntries(lines.map(({ r, l }) => [r.id, { action: l.start.action, size: l.start.amount ? String(Math.round(l.start.amount)) : "" }])));
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [declined, setDeclined] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  const open = lines.filter(({ r }) => r.open);
  const done = lines.filter(({ r }) => !r.open);
  const reportOf = (l: (typeof lines)[number]["l"]): Filter => (l.report?.action ?? "none");
  const shown = open.filter(({ l }) => filter === "all" || reportOf(l) === filter);
  const count = (f: Filter) => open.filter(({ l }) => reportOf(l) === f).length;
  const allPicked = shown.length > 0 && shown.every(({ r }) => picked.has(r.id));

  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const pickAll = () => setPicked(allPicked ? new Set() : new Set(shown.map(({ r }) => r.id)));

  function approveSelected() {
    setMsg(null);
    const errs: Record<string, string> = {};
    const answers: CheckAnswer[] = [];
    for (const { r, l } of open) {
      if (!picked.has(r.id)) continue;
      const c = choice[r.id];
      if (!c?.action) { errs[r.id] = "Choose Sell, Buy or Keep first."; continue; }
      if (c.action !== "RETAIN" && !c.size.trim()) { errs[r.id] = `Enter the amount to ${c.action === "SELL" ? "sell" : "buy"}.`; continue; }
      answers.push({
        itemId: r.id, action: c.action, size: c.action === "RETAIN" ? "" : c.size, note: approvalNote(l, c.action),
        // The part the CAS shows done goes with the answer only when the choice is that trade.
        done: l.done && l.done.doneFor === c.action ? { amount: l.done.amount, date: l.done.date } : null,
      });
    }
    setErrors(errs);
    if (!answers.length) { if (!Object.keys(errs).length) setMsg({ ok: false, text: "Tick the lines to approve." }); return; }
    start(async () => {
      const res = await approve(answers);
      const failed = Object.fromEntries((res.failed ?? []).map((f) => [f.itemId, f.error]));
      setErrors((e) => ({ ...e, ...failed }));
      setPicked(new Set(Object.keys(failed)));
      setDeclined((d) => { const n = new Set(d); for (const a of answers) n.delete(a.itemId); return n; });
      setMsg(res.ok ? { ok: true, text: res.message ?? "Approved." } : { ok: false, text: res.error });
      router.refresh();
    });
  }
  function declineSelected() {
    setDeclined((d) => new Set([...d, ...picked]));
    setPicked(new Set());
    setMsg({ ok: true, text: "Marked as not approved: they stay open. Change the choice and approve them, or leave them for later." });
  }
  function undo(id: string) {
    start(async () => {
      const res = await reopen(id);
      setMsg(res.ok ? { ok: true, text: res.message ?? "Undone." } : { ok: false, text: res.error });
      router.refresh();
    });
  }

  const cols = "grid-cols-[22px_minmax(140px,1fr)_96px_160px_minmax(240px,2fr)_200px_116px]";
  const head = (
    <div className={cn("grid items-center gap-2.5 bg-slate-50 px-4 py-2 text-[10.5px] font-semibold uppercase tracking-wide text-muted", cols)}>
      <span>{canAnswer && shown.length ? <input type="checkbox" checked={allPicked} onChange={pickAll} aria-label="Select all lines shown" className="h-4 w-4 accent-brand" /> : null}</span>
      <span>Fund</span><span>Report says</span><span>CAS shows</span><span>What&apos;s the issue → possible fix</span><span>Your choice</span><span>Status</span>
    </div>
  );

  return (
    <section id="questions" className={cn("scroll-mt-14 overflow-hidden rounded-xl border bg-surface", open.length ? "border-amber-300" : "border-border")}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <h3 className="text-[15px] font-semibold">{title ?? "Check the report against the CAS"}</h3>
        <span className="text-xs text-muted">{open.length ? `${open.length} of ${rows.length} left` : `all ${rows.length} answered`}</span>
        {open.length ? (
          <div className="flex flex-wrap gap-1.5 text-xs">
            {([["all", `All ${open.length}`], ["SELL", `Report: Sell ${count("SELL")}`], ["BUY", `Buy ${count("BUY")}`], ["RETAIN", `Keep ${count("RETAIN")}`], ["none", `Not in report / unclear ${count("none")}`]] as [Filter, string][])
              .filter(([f]) => f === "all" || count(f) > 0)
              .map(([f, t]) => (
                <button key={f} type="button" onClick={() => setFilter(f)} aria-pressed={filter === f}
                  className={cn("rounded-full px-2.5 py-0.5 ring-1", filter === f ? "bg-ink text-white ring-ink" : "bg-white ring-border hover:bg-slate-50")}>{t}</button>
              ))}
          </div>
        ) : null}
      </div>

      {canAnswer && open.length ? (
        <div className="flex flex-wrap items-center gap-2.5 border-t border-brand-100 bg-brand-50/60 px-4 py-2 text-[13px]">
          <b className="text-brand-800">{picked.size} selected</b>
          <button type="button" onClick={approveSelected} disabled={pending || !picked.size}
            className="inline-flex items-center gap-1 rounded-md bg-emerald-700 px-3 py-1.5 font-semibold text-white hover:bg-emerald-800 disabled:opacity-50">
            <Check className="h-3.5 w-3.5" /> {pending ? "Saving…" : `Approve ${picked.size || ""}`.trim()}
          </button>
          <button type="button" onClick={declineSelected} disabled={pending || !picked.size}
            className="inline-flex items-center gap-1 rounded-md bg-white px-3 py-1.5 font-semibold text-red-700 ring-1 ring-red-300 hover:bg-red-50 disabled:opacity-50">
            <X className="h-3.5 w-3.5" /> Not approve
          </button>
          <span className="text-muted">Approve saves <b>your choice</b> on each ticked line. It starts as what the report says; change it first if needed.</span>
        </div>
      ) : null}
      {msg ? <p role="status" className={cn("border-t border-border px-4 py-2 text-[13px]", msg.ok ? "text-emerald-800" : "text-red-700")}>{msg.text}</p> : null}

      <div className="overflow-x-auto border-t border-border">
        <div className="min-w-[1040px] text-[13px]">
          {head}
          {shown.map(({ r, l }) => {
            const c = choice[r.id];
            const isPicked = picked.has(r.id);
            const err = errors[r.id];
            return (
              <div key={r.id} className={cn("border-t border-slate-100", isPicked ? "bg-brand-50/50" : declined.has(r.id) || err ? "bg-red-50/50" : "")}>
                <div className={cn("grid items-center gap-2.5 px-4 py-2", cols)}>
                  <span>{canAnswer ? <input type="checkbox" checked={isPicked} onChange={() => toggle(r.id)} aria-label={`Select ${r.scheme_name}`} className="h-4 w-4 accent-brand" /> : null}</span>
                  <span className="truncate font-semibold" title={`${r.scheme_name}${r.folio_number ? ` · folio ${r.folio_number}` : ""}`}>{r.scheme_name}</span>
                  <ReportCell l={l} />
                  <span className="truncate" title={l.cas}>{l.cas}</span>
                  <span className="truncate" title={`${l.issue} → ${l.fix}${r.report_question ? `\n\n${r.report_question}` : ""}`}>
                    <span className="text-amber-800">{l.issue}</span> <span className="text-muted">→</span> <span className="text-emerald-800">{l.fix}</span>
                  </span>
                  {canAnswer ? (
                    <span className="flex gap-1.5">
                      <select value={c?.action ?? ""} aria-label={`Your choice for ${r.scheme_name}`}
                        onChange={(e) => setChoice((s) => ({ ...s, [r.id]: { ...s[r.id], action: (e.target.value || null) as CheckAction | null } }))}
                        className={cn("h-8 w-[84px] rounded-md border border-border bg-white px-1.5 text-[12.5px] font-semibold", c?.action ? TONE[c.action] : "text-muted")}>
                        <option value="">Choose</option>
                        <option value="SELL">Sell</option>
                        <option value="BUY">Buy</option>
                        <option value="RETAIN">Keep</option>
                      </select>
                      <input value={c?.action === "RETAIN" ? "" : c?.size ?? ""} disabled={c?.action === "RETAIN"} inputMode="decimal"
                        onChange={(e) => setChoice((s) => ({ ...s, [r.id]: { ...s[r.id], size: e.target.value } }))}
                        placeholder={c?.action === "RETAIN" ? "—" : "₹ or 33%"} aria-label={`Amount for ${r.scheme_name}`}
                        className="h-8 w-[110px] rounded-md border border-border bg-white px-2 text-right text-[12.5px] num disabled:bg-slate-50" />
                    </span>
                  ) : <span className="text-muted">—</span>}
                  <span>{declined.has(r.id) ? <Pill tone="red">Not approved</Pill> : <span className="text-[11px] text-muted">to check</span>}</span>
                </div>
                {err ? <p className="px-4 pb-2 pl-[52px] text-[12px] text-red-700">{err}</p> : null}
              </div>
            );
          })}
          {open.length && !shown.length ? <p className="border-t border-slate-100 px-4 py-3 text-[13px] text-muted">No open lines of this kind.</p> : null}
          {done.map(({ r, l }) => (
            <div key={r.id} className={cn("grid items-center gap-2.5 border-t border-slate-100 px-4 py-2 text-slate-600", cols)}>
              <span><Check className="h-4 w-4 text-emerald-600" aria-hidden /></span>
              <span className="truncate font-semibold text-ink" title={r.scheme_name}>{r.scheme_name}</span>
              <ReportCell l={l} />
              <span className="truncate" title={l.cas}>{l.cas}</span>
              <span className="truncate" title={r.report_answer ?? ""}>{l.issue} → {l.fix}</span>
              <span className={cn("font-semibold", TONE[(r.action as CheckAction) in ACT ? (r.action as CheckAction) : "RETAIN"])}>
                {ACT[r.action as CheckAction] ?? r.action}{r.action !== "RETAIN" && Number(r.target_amount) > 0 ? ` ${formatINRCompact(Number(r.target_amount))}` : ""}
                {r.report_diff?.done_answer ? <span className="font-normal text-muted"> · {formatINRCompact(r.report_diff.done_answer.amount)} done</span> : null}
              </span>
              <span className="flex items-center gap-2">
                <Pill tone="green">Approved</Pill>
                {canAnswer && draft && !r.report_diff?.done_call_id ? (
                  <button type="button" onClick={() => undo(r.id)} disabled={pending} className="text-[11.5px] text-brand hover:underline disabled:opacity-50">Undo</button>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function ReportCell({ l }: { l: ReturnType<typeof checkLine> }) {
  if (!l.report) return <span className="text-muted">Not in report</span>;
  if (!l.report.action) return <span className="truncate text-muted" title={l.report.words ?? ""}>Unclear</span>;
  return (
    <span className="truncate">
      <b className={TONE[l.report.action]}>{ACT[l.report.action]}</b>{l.report.amount ? ` ${formatINRCompact(l.report.amount)}` : ""}
    </span>
  );
}

function Pill({ tone, children }: { tone: "green" | "red"; children: React.ReactNode }) {
  return <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", tone === "green" ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700")}>{children}</span>;
}
