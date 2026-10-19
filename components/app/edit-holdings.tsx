"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Plus, X } from "lucide-react";
import { FundPicker, type PickedFund } from "@/components/app/fund-picker";
import { mixColor } from "@/components/app/client-allocation";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/form";
import { CAP_BUCKETS, marketCap } from "@/lib/domain/market-cap";
import { holdingChanges } from "@/lib/domain/holding-edits";
import { formatDate, formatINR, formatINRCompact, formatNav } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ActionResult } from "@/lib/actions";
import type { FundOption } from "@/services/fund-search";
import type { EditableHoldings } from "@/services/holding-corrections";

interface Row {
  key: string;
  holdingId: string | null;
  securityId: string | null;
  name: string;
  category: string | null;
  folio: string;
  units: string;
  nav: number | null;
  removed: boolean;
  fund: PickedFund | null;
}

const num = (s: string) => (s.trim() === "" ? NaN : Number(s.replace(/,/g, "")));

/**
 * Edit holdings: the client's current holdings (latest CAS or correction) at today's NAV.
 * Change units or folio, remove a fund, add one; saved as a correction with a date and reason.
 */
export function EditHoldings({
  clientId, clientName, data, focus, closeHref, search, save,
}: {
  clientId: string;
  clientName: string;
  data: EditableHoldings;
  focus: string | null;
  closeHref: string;
  search: (q: string) => Promise<FundOption[]>;
  save: (input: unknown) => Promise<ActionResult>;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const initial = useMemo<Row[]>(() => data.rows.map((h) => ({
    key: h.holding_id, holdingId: h.holding_id, securityId: h.security_id, name: h.scheme_name, category: h.category,
    folio: h.folio_number ?? "", units: String(h.units), nav: h.nav, removed: false, fund: null,
  })), [data.rows]);
  const [rows, setRows] = useState<Row[]>(initial);
  const [asOf, setAsOf] = useState(data.today);
  const [reason, setReason] = useState("");
  const focusRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    focusRef.current?.focus();
    focusRef.current?.scrollIntoView({ block: "center" });
    // Escape closes the editor, but not while typing (it would throw the edits away) or in the fund search.
    const esc = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (e.key !== "Escape" || e.defaultPrevented || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      router.replace(closeHref, { scroll: false });
    };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [router, closeHref]);

  const upd = (key: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const base = data.rows.map((h) => ({ holdingId: h.holding_id, name: h.scheme_name, folio: h.folio_number, units: h.units, nav: h.nav }));
  const live = rows.filter((r) => !r.removed && (r.holdingId || r.fund));
  const changes = holdingChanges(base, live.map((r) => ({
    holdingId: r.holdingId, name: r.fund?.scheme_name ?? r.name, folio: r.folio || null, units: num(r.units) || 0, nav: r.fund?.nav ?? r.nav,
  })));
  const before = data.rows.reduce((t, h) => t + h.units * (h.nav ?? 0), 0);
  const after = before + changes.reduce((t, c) => t + c.delta, 0);
  const firstFocus = focus ? rows.find((r) => r.securityId === focus)?.key : rows[0]?.key;

  function submit() {
    setError(null);
    const bad = live.find((r) => !(num(r.units) > 0));
    if (bad) return setError(`Enter the units for ${bad.fund?.scheme_name ?? bad.name} (more than 0), or remove it.`);
    if (rows.some((r) => !r.holdingId && !r.removed && !r.fund)) return setError("Choose the fund for every added line, or remove the empty line.");
    const noNav = live.find((r) => !r.holdingId && !r.fund?.nav);
    if (noNav) return setError(`${noNav.fund!.scheme_name} has no NAV in the daily feed: it cannot be valued.`);
    if (reason.trim().length < 3) return setError("Give a reason for the change: it is kept in History and the audit log.");
    start(async () => {
      const res = await save({
        clientId, baseSnapshotId: data.snapshotId, asOf, reason: reason.trim(),
        rows: live.map((r) => ({ holdingId: r.holdingId, fundRef: r.holdingId ? null : r.fund!.value, folio: r.folio.trim() || null, units: num(r.units) })),
      });
      if (!res.ok) return setError(res.error);
      router.replace(closeHref, { scroll: false });
      router.refresh();
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-labelledby="edit-holdings-title">
      <Link href={closeHref} scroll={false} className="absolute inset-0 bg-slate-900/35" aria-label="Close" />
      <div className="relative flex h-full w-full max-w-[880px] flex-col bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h2 id="edit-holdings-title" className="text-lg font-bold">Edit holdings · {clientName}</h2>
            {data.pendingCasDate ? (
              <p className="mt-1 rounded bg-amber-50 px-2 py-1 text-[12px] text-amber-800">
                A CAS of {formatDate(data.pendingCasDate)} is waiting to be checked. Once confirmed, it replaces the holdings you save here.
              </p>
            ) : null}
            <p className="mt-0.5 text-[12.5px] text-muted">
              Starting from {data.isCorrection ? "the correction" : "CAS"} of {formatDate(data.snapshotDate)} · {data.rows.length} {data.rows.length === 1 ? "holding" : "holdings"} · values at today&apos;s NAV
            </p>
          </div>
          <Link href={closeHref} scroll={false} className="rounded p-1 text-muted hover:bg-slate-100 hover:text-ink" aria-label="Close"><X className="h-5 w-5" /></Link>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <table className="w-full text-[13px]">
            <thead className="sticky top-0 z-10 bg-slate-50 text-[10.5px] font-semibold uppercase tracking-wide text-muted">
              <tr>
                <th className="px-5 py-2 text-left">Fund</th>
                <th className="w-40 px-2 py-2 text-left">Folio</th>
                <th className="w-32 px-2 py-2 text-right">Units</th>
                <th className="w-20 px-2 py-2 text-right">NAV</th>
                <th className="w-28 px-2 py-2 text-right">Value</th>
                <th className="w-14 py-2 pr-5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => {
                const orig = r.holdingId ? data.rows.find((h) => h.holding_id === r.holdingId)! : null;
                const u = num(r.units);
                const nav = r.fund?.nav ?? r.nav;
                const edited = orig && !r.removed && (Math.round(u * 10000) !== Math.round(orig.units * 10000) || (r.folio.trim() || null) !== (orig.folio_number?.trim() || null));
                const cap = marketCap(r.category, r.fund?.scheme_name ?? r.name);
                return (
                  <tr key={r.key} className={cn("align-top", r.removed ? "bg-red-50/70 text-muted" : !r.holdingId ? "bg-emerald-50/60" : edited ? "bg-amber-50/70" : focus && r.securityId === focus ? "bg-brand-50/40" : "")}>
                    <td className="px-5 py-2.5">
                      {r.holdingId ? (
                        <>
                          <div className={cn("font-semibold", r.removed && "line-through")}>
                            {r.name}
                            {r.removed ? <Tag tone="red">Removed</Tag> : edited ? <Tag tone="amber">Edited</Tag> : null}
                          </div>
                          <div className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-slate-600">
                            <span className="h-2 w-2 rounded-[2px]" style={{ background: mixColor(cap, CAP_BUCKETS.indexOf(cap)) }} aria-hidden />{cap}
                          </div>
                        </>
                      ) : (
                        <div className="flex items-center gap-1.5">
                          <FundPicker className="min-w-0 flex-1" search={search} value={r.fund} onChange={(f) => upd(r.key, { fund: f, category: null })} />
                          <Tag tone="green">Added</Tag>
                        </div>
                      )}
                      {!r.holdingId && r.fund && !r.fund.nav ? (
                        <p className="mt-1 text-[11px] text-red-700">This fund has no NAV in the daily feed yet, so it cannot be valued. Pick another option of it, or wait for the next NAV update.</p>
                      ) : null}
                    </td>
                    <td className="px-2 py-2.5">
                      {r.removed ? <span className="text-[13px]">{r.folio || "—"}</span> : (
                        <Input value={r.folio} onChange={(e) => upd(r.key, { folio: e.target.value })} className="h-8 text-[13px]" placeholder="Folio" aria-label={`Folio of ${r.name}`} maxLength={40} />
                      )}
                    </td>
                    <td className="px-2 py-2.5 text-right">
                      {r.removed ? <span className="line-through num">{r.units}</span> : (
                        <>
                          <Input ref={r.key === firstFocus ? focusRef : undefined} value={r.units} inputMode="decimal" onChange={(e) => upd(r.key, { units: e.target.value })}
                            className={cn("h-8 text-right text-[13px] num", (edited || !r.holdingId) && "border-amber-400 bg-amber-50", r.units && !(u > 0) && "border-red-400")}
                            aria-label={`Units of ${r.fund?.scheme_name ?? r.name}`} />
                          {edited && orig && Math.round(u * 10000) !== Math.round(orig.units * 10000) ? <div className="mt-0.5 text-[11px] text-amber-800 num">was {orig.units.toLocaleString("en-IN", { minimumFractionDigits: 3, maximumFractionDigits: 4 })}</div> : null}
                        </>
                      )}
                    </td>
                    <td className="px-2 pt-4 text-right text-slate-600 num">{nav ? formatNav(nav) : "—"}</td>
                    <td className={cn("px-2 pt-4 text-right font-semibold num", r.removed && "line-through")}>{nav && u > 0 ? formatINR(u * nav) : "—"}</td>
                    <td className="py-2.5 pr-5 text-center">
                      {r.removed ? (
                        <button type="button" onClick={() => upd(r.key, { removed: false })} className="pt-1.5 text-xs font-medium text-brand hover:underline">Undo</button>
                      ) : (
                        <button type="button" onClick={() => (r.holdingId ? upd(r.key, { removed: true }) : setRows((rs) => rs.filter((x) => x.key !== r.key)))}
                          className="rounded p-1.5 text-muted hover:bg-red-50 hover:text-red-700" aria-label={`Remove ${r.fund?.scheme_name ?? r.name}`} title="Remove this holding">
                          <X className="h-4 w-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="border-b border-border px-5 py-3">
            <button type="button" onClick={() => setRows((rs) => [...rs, { key: `new-${Date.now()}`, holdingId: null, securityId: null, name: "", category: null, folio: "", units: "", nav: null, removed: false, fund: null }])}
              className="flex w-full items-center gap-1.5 rounded-md border border-dashed border-brand-200 bg-brand-50/40 px-3 py-2 text-[13px] font-medium text-brand hover:bg-brand-50">
              <Plus className="h-4 w-4" /> Add a fund
            </button>
          </div>

          <div className="grid gap-4 border-b border-border px-5 py-4 sm:grid-cols-[180px_1fr]">
            <label className="flex flex-col gap-1 text-xs font-semibold text-slate-700">
              Holdings as of *
              <Input type="date" value={asOf} min={data.snapshotDate} max={data.today} onChange={(e) => setAsOf(e.target.value)} className="h-9 text-[13px] font-normal" />
              <span className="text-[11px] font-normal text-muted">Units as they are on this date, with every trade done before it.</span>
            </label>
            <label className="flex flex-col gap-1 text-xs font-semibold text-slate-700">
              Reason (kept in History and the audit log) *
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={1000} className="text-[13px] font-normal"
                placeholder="e.g. Client shared a statement: 1,200 units bought on their own app on 15-Oct" />
            </label>
          </div>

          <div className="border-b border-border bg-slate-50 px-5 py-3 text-[13px]">
            {changes.length ? (
              <>
                <b>{changes.length} {changes.length === 1 ? "change" : "changes"} · in funds {formatINRCompact(before)} → {formatINRCompact(after)}</b>
                <ul className="mt-1 space-y-0.5 text-slate-600">
                  {changes.map((c, i) => (
                    <li key={i}>{c.text} <span className={cn("num", c.delta >= 0 ? "text-emerald-700" : "text-red-700")}>({c.delta >= 0 ? "+" : "−"}{formatINRCompact(Math.abs(c.delta))})</span></li>
                  ))}
                </ul>
              </>
            ) : <span className="text-muted">No changes yet.</span>}
          </div>
          <p className="px-5 py-3 text-xs leading-relaxed text-muted">
            Saved as a new holdings version, &ldquo;Holdings corrected by hand&rdquo;. The CAS stays as it was, and a CAS dated after this replaces it.
            Plan lines, calls and executions do not change; values and the Allocation card update at once.
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          {error ? <p role="alert" className="mr-auto text-[13px] text-red-700">{error}</p> : null}
          <Link href={closeHref} scroll={false} className="rounded-md border border-border bg-white px-3.5 py-2 text-[13px] hover:bg-slate-50">Cancel</Link>
          <Button type="button" onClick={submit} disabled={pending || !changes.length}>
            {pending ? "Saving…" : `Save ${changes.length || ""} ${changes.length === 1 ? "change" : "changes"}`.replace("  ", " ")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Tag({ tone, children }: { tone: "amber" | "red" | "green"; children: React.ReactNode }) {
  const t = { amber: "bg-amber-100 text-amber-800", red: "bg-red-100 text-red-700", green: "bg-emerald-100 text-emerald-800" }[tone];
  return <span className={cn("ml-1.5 rounded px-1.5 py-px text-[10.5px] font-semibold no-underline", t)}>{children}</span>;
}
