"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import { Badge } from "@/components/ui/badge";
import { Money } from "@/components/app/money";
import { formatDate, formatUnits } from "@/lib/format";
import type { BulkUnadvisedInput, BulkUnadvisedResult } from "../actions";

export interface UnadvisedRow {
  id: string;
  scheme_name: string;
  folio: string | null;
  change_type: string;
  transaction_date: string | null;
  transaction_amount: number | null;
  transaction_units: number | null;
  transaction_nav: number | null;
  approx_amount: number;
  system_note: string | null;
  resolution_note: string | null;
  /** TO_REVIEW, ADVISED (recorded as advised), NOT_ADVISED (acknowledged), CLOSED (rejected otherwise). */
  state: "TO_REVIEW" | "ADVISED" | "NOT_ADVISED" | "CLOSED";
  reviewed_at: string | null;
  /** "I've advised" needs the CAS transaction behind the row. */
  canRecordAdvised: boolean;
}

type Filter = "TO_REVIEW" | "REVIEWED" | "ALL";
type Side = "ALL" | "SELL" | "BUY";

const CHANNEL_OPTIONS = [["PHONE", "Phone"], ["WHATSAPP", "WhatsApp"], ["EMAIL", "Email"], ["IN_PERSON", "In person"], ["OTHER", "Other"]] as const;

export function UnadvisedReview({ rows, canAdvise, act }: {
  rows: UnadvisedRow[];
  canAdvise: boolean;
  act: (input: BulkUnadvisedInput) => Promise<BulkUnadvisedResult>;
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>(rows.some((r) => r.state === "TO_REVIEW") ? "TO_REVIEW" : "ALL");
  const [side, setSide] = useState<Side>("ALL");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<"ADVISED" | "NOT_ADVISED" | null>(null);
  const [note, setNote] = useState("");
  const [channel, setChannel] = useState<string>("PHONE");
  const [callTime, setCallTime] = useState("");
  const [result, setResult] = useState<{ text: string; failed: BulkUnadvisedResult["failed"] } | null>(null);
  const [pending, start] = useTransition();

  const visible = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter((r) => {
      if (filter === "TO_REVIEW" && r.state !== "TO_REVIEW") return false;
      if (filter === "REVIEWED" && r.state === "TO_REVIEW") return false;
      if (side === "SELL" && r.change_type !== "DECREASE") return false;
      if (side === "BUY" && r.change_type === "DECREASE") return false;
      if (!terms.length) return true;
      const hay = [r.scheme_name, r.folio ?? "", r.transaction_date ?? "", formatDate(r.transaction_date ?? ""),
        String(Math.round(r.approx_amount)), r.system_note ?? "", r.resolution_note ?? ""].join(" ").toLowerCase();
      return terms.every((t) => hay.includes(t.replace(/,/g, "")) || hay.replace(/,/g, "").includes(t.replace(/,/g, "")));
    });
  }, [rows, q, filter, side]);

  const selectable = visible.filter((r) => r.state === "TO_REVIEW");
  const chosen = rows.filter((r) => selected.has(r.id) && r.state === "TO_REVIEW");
  const allChosen = selectable.length > 0 && selectable.every((r) => selected.has(r.id));
  const chosenTotal = chosen.reduce((t, r) => t + r.approx_amount, 0);
  const notRecordable = chosen.filter((r) => !r.canRecordAdvised).length;

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAll = () => setSelected((s) => {
    const n = new Set(s);
    if (allChosen) selectable.forEach((r) => n.delete(r.id)); else selectable.forEach((r) => n.add(r.id));
    return n;
  });

  const submit = () => {
    if (!mode || !chosen.length) return;
    const ids = mode === "ADVISED" ? chosen.filter((r) => r.canRecordAdvised).map((r) => r.id) : chosen.map((r) => r.id);
    start(async () => {
      const res = await act({ ids, decision: mode, note, channel: channel as BulkUnadvisedInput["channel"], communicatedAt: callTime || null });
      const done = mode === "ADVISED" ? "recorded as advised (call logged, trade counted as executed)" : "marked as not advised";
      setResult({ text: `${res.ok} trade(s) ${done}.${res.failed.length ? ` ${res.failed.length} could not be saved:` : ""}`, failed: res.failed });
      if (res.ok) {
        setSelected(new Set());
        setMode(null);
        setNote("");
        router.refresh();
      }
    });
  };

  const stateBadge = (r: UnadvisedRow) =>
    r.state === "ADVISED" ? <Badge tone="success">Advised (recorded)</Badge>
      : r.state === "NOT_ADVISED" ? <Badge>Not advised{r.reviewed_at ? ` · ${formatDate(r.reviewed_at)}` : ""}</Badge>
      : r.state === "CLOSED" ? <span className="text-xs text-muted">Closed</span>
      : <Badge tone="danger">To review</Badge>;

  return (
    <div>
      {/* Search and filters */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search fund, folio, amount or date…" className="h-9 w-72" aria-label="Search unadvised trades" />
        <div className="flex gap-1 rounded-md bg-slate-100 p-1 text-xs">
          {([["TO_REVIEW", "To review"], ["REVIEWED", "Reviewed"], ["ALL", "All"]] as const).map(([v, l]) => (
            <button key={v} type="button" onClick={() => setFilter(v)} className={`rounded px-2 py-1 ${filter === v ? "bg-white font-medium shadow-sm" : "text-muted"}`}>
              {l} ({v === "ALL" ? rows.length : rows.filter((r) => (v === "TO_REVIEW" ? r.state === "TO_REVIEW" : r.state !== "TO_REVIEW")).length})
            </button>
          ))}
        </div>
        <div className="flex gap-1 rounded-md bg-slate-100 p-1 text-xs">
          {([["ALL", "Buys & sells"], ["SELL", "Redeemed"], ["BUY", "Invested"]] as const).map(([v, l]) => (
            <button key={v} type="button" onClick={() => setSide(v)} className={`rounded px-2 py-1 ${side === v ? "bg-white font-medium shadow-sm" : "text-muted"}`}>{l}</button>
          ))}
        </div>
        <span className="ml-auto text-xs text-muted">{visible.length} shown</span>
      </div>

      {/* Bulk bar */}
      <div className="flex flex-wrap items-center gap-2 bg-slate-50 px-4 py-2 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={allChosen} onChange={toggleAll} disabled={!selectable.length} aria-label="Select all shown" />
          Select all shown
        </label>
        <span className="text-muted">· {chosen.length} selected{chosen.length ? <> · <Money value={chosenTotal} /></> : null}</span>
        <div className="ml-auto flex gap-2">
          {canAdvise ? (
            <Button type="button" size="sm" variant={mode === "ADVISED" ? "default" : "outline"} disabled={!chosen.length} onClick={() => setMode("ADVISED")}>I&apos;ve advised</Button>
          ) : null}
          <Button type="button" size="sm" variant={mode === "NOT_ADVISED" ? "default" : "outline"} disabled={!chosen.length} onClick={() => setMode("NOT_ADVISED")}>I haven&apos;t advised</Button>
        </div>
      </div>
      {mode && chosen.length ? (
        <div className="space-y-2 border-y border-border bg-white px-4 py-3 text-sm">
          {mode === "ADVISED" ? (
            <>
              <p className="text-xs text-muted">
                Records a call for each selected trade (on its plan line when the plan has that fund) and counts the CAS trade as its execution.
                {notRecordable ? ` ${notRecordable} selected row(s) have no single CAS transaction and will be skipped.` : ""}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Select value={channel} onChange={(e) => setChannel(e.target.value)} className="h-9 w-32 text-xs" aria-label="Channel">
                  {CHANNEL_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </Select>
                <label className="flex items-center gap-1 text-xs text-muted">
                  Call time
                  <Input type="datetime-local" value={callTime} onChange={(e) => setCallTime(e.target.value)} className="h-9 w-48 text-xs" />
                </label>
                <span className="text-[11px] text-muted">{callTime ? "Must be on or before every selected trade." : "Empty: each trade's own day at 09:00."}</span>
              </div>
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional), e.g. advised on WhatsApp" className="h-9" />
            </>
          ) : (
            <>
              <p className="text-xs text-muted">Marks the selected trades as done by the client without your advice. They stay in history as unadvised.</p>
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What did the client say? (required)" className="h-9" />
            </>
          )}
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={submit} disabled={pending || (mode === "NOT_ADVISED" && !note.trim())}>
              {pending ? "Saving…" : `Save for ${mode === "ADVISED" ? chosen.length - notRecordable : chosen.length} trade(s)`}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setMode(null)}>Cancel</Button>
          </div>
        </div>
      ) : null}
      {result ? (
        <div role="status" className={`px-4 py-2 text-sm ${result.failed.length ? "bg-amber-50 text-amber-800" : "bg-emerald-50 text-emerald-800"}`}>
          {result.text}
          {result.failed.length ? (
            <ul className="mt-1 list-disc pl-5 text-xs">
              {result.failed.slice(0, 10).map((f, i) => (
                <li key={`${f.id}-${i}`}>{rows.find((r) => r.id === f.id)?.scheme_name ?? "Request"}: {f.error}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* Rows */}
      {visible.length === 0 ? (
        <p className="p-4 text-sm text-muted">{rows.length ? "Nothing matches this search or filter." : "None — every change is explained by advice or SIP instalments."}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead className="text-left text-[11px] uppercase tracking-wide text-muted">
              <tr className="border-b border-border">
                <th className="w-8 px-3 py-2" />
                <th className="px-2 py-2">Security</th>
                <th className="px-2 py-2">CAS transaction</th>
                <th className="px-2 py-2 text-right">Unadvised amount</th>
                <th className="px-2 py-2">Note</th>
                <th className="px-2 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.id} className={`border-b border-border align-top ${selected.has(r.id) && r.state === "TO_REVIEW" ? "bg-blue-50/50" : ""}`}>
                  <td className="px-3 py-2">
                    {r.state === "TO_REVIEW" ? <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Select ${r.scheme_name}`} /> : null}
                  </td>
                  <td className="max-w-72 px-2 py-2">
                    <div className="truncate font-medium" title={r.scheme_name}>{r.scheme_name}</div>
                    {r.folio ? <div className="text-[11px] text-muted">Folio {r.folio}</div> : null}
                  </td>
                  <td className="px-2 py-2 text-xs">
                    {r.transaction_date ? (
                      <>
                        <div className="font-medium">{formatDate(r.transaction_date)}</div>
                        <div className={r.change_type === "DECREASE" ? "text-red-700" : "text-emerald-700"}>
                          {r.change_type === "DECREASE" ? "Redeemed" : "Invested"} <Money value={r.transaction_amount} full />
                        </div>
                        <div className="num text-muted">{formatUnits(r.transaction_units)} u @ {r.transaction_nav ?? "—"}</div>
                      </>
                    ) : <span className="text-muted">{r.change_type === "DECREASE" ? "Holding decreased" : "Holding increased"}</span>}
                  </td>
                  <td className="px-2 py-2 text-right font-medium text-red-700"><Money value={r.approx_amount} /></td>
                  <td className="max-w-64 px-2 py-2 text-xs text-muted">{r.system_note}{r.resolution_note ? <div className="text-ink">{r.resolution_note}</div> : null}</td>
                  <td className="px-2 py-2">{stateBadge(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
