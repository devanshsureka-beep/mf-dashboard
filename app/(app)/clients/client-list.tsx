"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { Input, Select } from "@/components/ui/form";
import type { ActionResult } from "@/lib/actions";
import { formatINRCompact } from "@/lib/format";
import { cn } from "@/lib/utils";

type Tone = "amber" | "blue" | "grey" | "red" | "brand";
export interface ListTag { text: string; tone: Tone; href?: string }
export interface ListRow {
  id: string;
  name: string;
  code: string;
  tag: ListTag | null;
  subTags: ListTag[];
  advisor: string;
  risk: string;
  valueToday: number | null;
  inFunds: number | null;
  inBank: number;
  tranche: string | null;
  donePct: number | null;
  advisedPct: number;
  left: number;
  waiting: number;
  sip: number;
  premium: number;
  premiumNote: string;
  premiumTone: "green" | "amber" | "red";
  agreementGap: string | null;
  latestCas: string | null;
  since: string;
}

type Action = (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
type Key = "name" | "advisor" | "today" | "funds" | "bank" | "tranche" | "waiting" | "sip" | "premium" | "cas";

const TAG: Record<Tone, string> = {
  amber: "bg-amber-50 text-amber-800",
  blue: "bg-blue-50 text-blue-700 ring-1 ring-blue-200 rounded-full px-2",
  grey: "bg-white text-slate-700 ring-1 ring-border rounded-full px-2",
  red: "bg-red-50 text-red-700",
  brand: "bg-brand-50 text-brand-700",
};

const COLS: { key: Key; label: string; right?: boolean; value: (r: ListRow) => number | string }[] = [
  { key: "name", label: "Client", value: (r) => r.name.toLowerCase() },
  { key: "advisor", label: "Advisor · risk", value: (r) => r.advisor.toLowerCase() },
  { key: "today", label: "Value today", right: true, value: (r) => r.valueToday ?? -1 },
  { key: "funds", label: "In funds", right: true, value: (r) => r.inFunds ?? -1 },
  { key: "bank", label: "In bank", right: true, value: (r) => r.inBank },
  { key: "tranche", label: "Tranche · done · left", value: (r) => (r.donePct == null ? -1 : r.donePct) },
  { key: "waiting", label: "Waiting", right: true, value: (r) => r.waiting },
  { key: "sip", label: "SIP / mo", right: true, value: (r) => r.sip },
  { key: "premium", label: "Premium", value: (r) => r.premium },
  { key: "cas", label: "Latest CAS", value: (r) => r.latestCas ?? "" },
];

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** 25-Aug-26: short enough to keep the table on one screen. */
const short = (d: string) => `${d.slice(8, 10)}-${MON[Number(d.slice(5, 7)) - 1]}-${d.slice(2, 4)}`;
const M = (v: number | null) => (v == null ? "—" : v < 0.5 ? "—" : formatINRCompact(v));

function Tag({ t }: { t: ListTag }) {
  const cls = cn("rounded px-1 text-[11px]", TAG[t.tone]);
  return t.href ? <Link href={t.href} className={cn(cls, "hover:underline")}>{t.text}</Link> : <span className={cls}>{t.text}</span>;
}

/**
 * The client table: tick clients for one action on all of them, click any
 * column header to sort it high → low or low → high.
 */
export function ClientList({ rows, isAdmin, canAdvise, advisors, deleteAction, reassignAction }: {
  rows: ListRow[];
  isAdmin: boolean;
  canAdvise: boolean;
  advisors: { id: string; name: string }[];
  deleteAction: Action;
  reassignAction: Action;
}) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<{ key: Key; dir: 1 | -1 } | null>(null);
  const [zipping, setZipping] = useState(false);

  const shown = useMemo(() => {
    if (!sort) return rows;
    const col = COLS.find((c) => c.key === sort.key)!;
    return [...rows].sort((a, b) => {
      const x = col.value(a), y = col.value(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  }, [rows, sort]);

  const allOn = rows.length > 0 && rows.every((r) => sel.has(r.id));
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const ids = [...sel];
  const hidden = ids.map((id) => <input key={id} type="hidden" name="ids" value={id} />);

  // One ZIP per client, one after another so the browser does not block them.
  async function downloadZips() {
    setZipping(true);
    for (const id of ids) {
      const a = document.createElement("a");
      a.href = `/api/clients/${id}/export`;
      a.download = "";
      document.body.appendChild(a);
      a.click();
      a.remove();
      await new Promise((r) => setTimeout(r, 1200));
    }
    setZipping(false);
  }

  return (
    <>
      {sel.size ? (
        <div className="sticky top-0 z-30 mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-[13px]">
          <b className="text-brand-700">{sel.size} selected</b>
          {canAdvise ? <Link href={`/advice/bulk?ids=${ids.join(",")}`} className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700">Issue one call to all</Link> : null}
          <button type="button" onClick={downloadZips} disabled={zipping} className="rounded-md border border-border bg-white px-3 py-1.5 text-xs font-medium hover:bg-slate-50 disabled:opacity-60">
            {zipping ? "Downloading…" : `Download ZIPs (${sel.size})`}
          </button>
          {isAdmin ? (
            <details className="relative">
              <summary className="cursor-pointer list-none rounded-md border border-border bg-white px-3 py-1.5 text-xs font-medium hover:bg-slate-50">Change advisor ▾</summary>
              <ActionForm action={reassignAction} className="absolute left-0 top-9 z-40 w-80 space-y-2 rounded-lg border border-border bg-white p-3 shadow-lg">
                {hidden}
                <Select name="advisor_id" required defaultValue="" aria-label="New advisor">
                  <option value="" disabled>New primary advisor…</option>
                  {advisors.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </Select>
                <Input name="reason" required placeholder="Reason" aria-label="Reason for change" />
                <SubmitButton size="sm">Move {sel.size} client(s)</SubmitButton>
              </ActionForm>
            </details>
          ) : null}
          {isAdmin ? (
            <details className="relative">
              <summary className="cursor-pointer list-none rounded-md border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50">Delete (admin) ▾</summary>
              <ActionForm action={deleteAction} className="absolute left-0 top-9 z-40 w-80 space-y-2 rounded-lg border border-border bg-white p-3 shadow-lg">
                {hidden}
                <Input name="reason" required placeholder="Reason (e.g. duplicate onboarding)" aria-label="Reason for deleting" />
                <p className="text-[11px] text-muted">Hidden from every screen; history is kept and an admin can restore them.</p>
                <SubmitButton size="sm" variant="danger" confirm={`Delete ${sel.size} client(s)?`}>Delete {sel.size} client(s)</SubmitButton>
              </ActionForm>
            </details>
          ) : null}
          <button type="button" onClick={() => setSel(new Set())} className="ml-auto text-xs text-brand hover:underline">Clear</button>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-xl border border-border bg-surface">
        {rows.length === 0 ? <p className="p-4 text-sm text-muted">No clients match these filters.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1060px] text-[13px]">
              <thead className="border-b border-border bg-slate-50 text-left text-[10.5px] font-semibold uppercase tracking-wide text-muted">
                <tr>
                  <th className="w-8 py-2 pl-3">
                    <input type="checkbox" checked={allOn} onChange={() => setSel(allOn ? new Set() : new Set(rows.map((r) => r.id)))} aria-label="Select all clients" />
                  </th>
                  {COLS.map((c) => {
                    const on = sort?.key === c.key;
                    return (
                      <th key={c.key} className={cn("px-2 py-2", c.right && "text-right")} aria-sort={on ? (sort!.dir === 1 ? "ascending" : "descending") : undefined}>
                        <button type="button" title="Sort"
                          onClick={() => setSort(on ? { key: c.key, dir: sort!.dir === 1 ? -1 : 1 } : { key: c.key, dir: c.right ? -1 : 1 })}
                          className={cn("inline-flex items-center gap-1 uppercase tracking-wide hover:text-ink", on && "text-brand")}>
                          {c.label} <span aria-hidden className={cn("text-[9px]", on ? "text-brand" : "text-slate-300")}>{on ? (sort!.dir === 1 ? "▲" : "▼") : "↕"}</span>
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {shown.map((r) => {
                  const on = sel.has(r.id);
                  return (
                    <tr key={r.id} className={on ? "bg-brand-50/50" : "hover:bg-slate-50/70"}>
                      <td className="py-2 pl-3 align-top"><input type="checkbox" checked={on} onChange={() => toggle(r.id)} aria-label={`Select ${r.name}`} /></td>
                      <td className="px-2 py-2">
                        <Link href={`/clients/${r.id}`} className="font-semibold text-ink hover:underline">{r.name}</Link>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5"><span className="font-mono text-[11px] text-muted">{r.code}</span>{r.tag ? <Tag t={r.tag} /> : null}</div>
                        {r.subTags.length ? <div className="mt-0.5 flex flex-wrap gap-1">{r.subTags.map((t) => <Tag key={t.text} t={t} />)}</div> : null}
                      </td>
                      <td className="px-2 py-2 text-xs">{r.advisor}<div className="text-muted">{r.risk}</div></td>
                      <td className="px-2 py-2 text-right font-semibold num">{M(r.valueToday)}</td>
                      <td className="px-2 py-2 text-right num">{M(r.inFunds)}</td>
                      <td className={cn("px-2 py-2 text-right num", r.inBank >= 0.5 ? "text-amber-700" : "text-muted")}>{M(r.inBank)}</td>
                      <td className="w-44 px-2 py-2">
                        {r.donePct == null ? <span className="text-xs text-muted">{r.tranche ?? "No active plan"}</span> : (
                          <>
                            <div className="flex justify-between gap-2 text-[11px]"><span><span className="text-slate-600">{r.tranche}</span> · <span className="text-emerald-700">{r.donePct}% done</span></span><span className="text-muted">{r.left >= 0.5 ? `${formatINRCompact(r.left)} left` : "nothing left"}</span></div>
                            <div className="mt-0.5 h-1.5 rounded-full bg-slate-100">
                              <div className="relative h-1.5 rounded-full bg-blue-200" style={{ width: `${Math.min(r.advisedPct, 100)}%` }}>
                                <div className="absolute inset-y-0 left-0 rounded-full bg-emerald-500" style={{ width: r.advisedPct ? `${Math.min((r.donePct / r.advisedPct) * 100, 100)}%` : "0%" }} />
                              </div>
                            </div>
                          </>
                        )}
                      </td>
                      <td className={cn("px-2 py-2 text-right num", r.waiting >= 0.5 ? "font-semibold text-amber-700" : "text-muted")}>{M(r.waiting)}</td>
                      <td className="px-2 py-2 text-right text-violet-700 num">{M(r.sip)}</td>
                      <td className="whitespace-nowrap px-2 py-2 text-xs">
                        {M(r.premium)}
                        <div className={{ green: "text-emerald-700", amber: "text-amber-700", red: "text-red-700" }[r.premiumTone]}>{r.premiumNote}</div>
                        {r.agreementGap ? <div className="text-red-700">{r.agreementGap}</div> : null}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 pr-3 text-xs">{r.latestCas ? short(r.latestCas) : <span className="text-muted">No CAS</span>}<div className="text-muted">since {short(r.since)}</div></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
