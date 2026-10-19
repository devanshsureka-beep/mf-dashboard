"use client";

import { useState } from "react";
import { formatINRCompact } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ASSET_CLASSES } from "@/lib/domain/book";
import { CAP_BUCKETS, type MixBy, type MixSlice } from "@/lib/domain/market-cap";

/** Categorical slots in a fixed order (validated for colour-blind separation); "Other" is always grey. */
export const MIX_SLOTS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
const OTHER = "#94a3b8";
export const mixColor = (label: string, i: number) => (label === "Other" || label === "Unknown AMC" ? OTHER : MIX_SLOTS[i % MIX_SLOTS.length]);

const TABS: { key: MixBy; label: string }[] = [{ key: "cap", label: "Market cap" }, { key: "class", label: "Asset class" }, { key: "amc", label: "AMC" }];
const pct = (v: number) => `${Math.round(v * 100)}%`;

export interface MixView { slices: MixSlice[]; now: number; after: number }

/**
 * Where the client's money sits, now and after the active plan: one small donut (now) and a
 * two-column legend with each group's share now → after. Market cap / asset class / AMC switch.
 */
export function ClientAllocation({ views, hasPlan }: { views: Record<MixBy, MixView>; hasPlan: boolean }) {
  const [by, setBy] = useState<MixBy>("cap");
  const v = views[by];
  // Market cap and asset class keep a fixed colour per group (so the same group is the same colour on every client).
  const colorOf = (s: MixSlice, i: number) => {
    const fixed = by === "cap" ? (CAP_BUCKETS as readonly string[]).indexOf(s.label) : by === "class" ? (ASSET_CLASSES as readonly string[]).indexOf(s.label) : -1;
    return mixColor(s.label, fixed >= 0 ? fixed : i);
  };
  const r = 40, c = 2 * Math.PI * r;
  const shown = v.slices.filter((s) => s.now >= 0.5);
  const starts = shown.map((_, i) => shown.slice(0, i).reduce((t, s) => t + s.nowShare * c, 0));
  return (
    <section className="flex flex-col gap-1.5 rounded-xl border border-border bg-surface px-4 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Allocation {hasPlan ? <span className="text-[11px] font-normal text-muted">now → after plan</span> : null}</h3>
        <div role="tablist" aria-label="Group by" className="flex gap-px rounded-md p-0.5 ring-1 ring-border">
          {TABS.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={by === t.key} onClick={() => setBy(t.key)}
              className={cn("rounded px-2 py-0.5 text-[11.5px]", by === t.key ? "bg-ink font-semibold text-white" : "text-slate-600 hover:bg-slate-50")}>{t.label}</button>
          ))}
        </div>
      </div>
      {v.now < 0.5 ? <p className="py-6 text-center text-sm text-muted">No funds yet: the first CAS shows them.</p> : (
        <div className="flex items-center gap-4">
          <svg viewBox="0 0 100 100" className="h-28 w-28 shrink-0" role="img"
            aria-label={`${TABS.find((t) => t.key === by)?.label}: ${shown.map((s) => `${s.label} ${pct(s.nowShare)}`).join(", ")}`}>
            <g transform="rotate(-90 50 50)">
              {shown.map((s, i) => {
                const len = Math.max(1.5, s.nowShare * c - (shown.length > 1 && s.nowShare * c > 4 ? 1.6 : 0));
                const idx = v.slices.indexOf(s);
                return (
                  <circle key={s.label} cx={50} cy={50} r={r} fill="none" stroke={colorOf(s, idx)} strokeWidth={13}
                    strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-starts[i]}>
                    <title>{`${s.label}: ${formatINRCompact(s.now)} · ${pct(s.nowShare)}`}</title>
                  </circle>
                );
              })}
            </g>
            <text x={50} y={47} textAnchor="middle" fontSize={7} letterSpacing={0.3} fill="#64748b">IN FUNDS</text>
            <text x={50} y={60} textAnchor="middle" fontSize={13} fontWeight={700} fill="#0f172a">{formatINRCompact(v.now)}</text>
          </svg>
          <ul className="grid min-w-0 flex-1 grid-cols-1 gap-x-5 gap-y-0.5 sm:grid-cols-2">
            {v.slices.map((s, i) => {
              const up = s.afterShare - s.nowShare;
              const tone = Math.abs(up) < 0.005 ? "text-muted" : up > 0 ? "text-emerald-700" : "text-red-700";
              return (
                <li key={s.label} className="grid grid-cols-[10px_minmax(0,1fr)_auto_auto] items-center gap-1.5 text-[12.5px] leading-[18px]"
                  title={`${s.hint ? `${s.hint}. ` : ""}${formatINRCompact(s.now)} now${hasPlan ? ` → ${formatINRCompact(s.after)} after the plan` : ""}`}>
                  <span className="h-2 w-2 rounded-full" style={{ background: colorOf(s, i) }} aria-hidden />
                  <span className="truncate">{s.label}</span>
                  <b className="text-right num">{pct(s.nowShare)}</b>
                  {hasPlan ? <span className={cn("w-11 text-right text-[11.5px] num", tone)}>→ {pct(s.afterShare)}</span> : <span className="w-12 text-right text-[11.5px] text-muted num">{formatINRCompact(s.now)}</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
