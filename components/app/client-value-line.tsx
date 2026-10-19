"use client";

import { useState } from "react";
import { formatDate, formatINRCompact } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface ValuePoint { date: string; value: number; cas: boolean }

/**
 * Money in funds at each confirmed CAS since onboarding, then today at the latest NAV. One line,
 * the CAS points as dots, a crosshair and a readout on hover (or focus).
 */
export function ClientValueLine({ points, change, changePct }: { points: ValuePoint[]; change: number; changePct: number | null }) {
  const [at, setAt] = useState<number | null>(null);
  const W = 560, H = 128, L = 46, R = 12, T = 10, B = 20;
  const vals = points.map((p) => p.value);
  const max = Math.max(...vals, 1), min = Math.min(...vals, max);
  const pad = (max - min) * 0.2 || max * 0.05;
  const lo = Math.max(0, min - pad), hi = max + pad;
  const x = (i: number) => L + (i * (W - L - R)) / Math.max(1, points.length - 1);
  const y = (v: number) => T + ((hi - v) / (hi - lo || 1)) * (H - T - B);
  const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = points.length > 1 ? `M${x(0)},${y(lo)} L${line.replaceAll(" ", " L")} L${x(points.length - 1)},${y(lo)} Z` : "";
  // At most ~6 date labels, always the first and the last.
  const step = Math.max(1, Math.ceil(points.length / 6));
  const cur = at;
  return (
    <section className="flex flex-col gap-1 rounded-xl border border-border bg-surface px-4 py-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">Portfolio value <span className="text-[11px] font-normal text-muted">in funds · dots = CAS</span></h3>
        {changePct != null ? (
          <span className={cn("text-[12.5px] font-semibold num", change >= 0 ? "text-emerald-700" : "text-red-700")}>
            {change >= 0 ? "+" : "−"}{Math.abs(changePct).toFixed(1)}% since onboarding <span className="font-normal text-muted">(funds + bank)</span>
          </span>
        ) : null}
      </div>
      {points.length < 2 ? <p className="py-8 text-center text-sm text-muted">The line starts with the client&apos;s next CAS.</p> : (
        <div className="relative" onMouseLeave={() => setAt(null)}>
          <svg viewBox={`0 0 ${W} ${H}`} className="h-32 w-full" preserveAspectRatio="none" role="group"
            aria-label={`Money in funds from ${formatDate(points[0].date)} (${formatINRCompact(points[0].value)}) to ${formatDate(points[points.length - 1].date)} (${formatINRCompact(points[points.length - 1].value)})`}>
            {[lo + (hi - lo) / 6, (lo + hi) / 2, hi - (hi - lo) / 6].map((t) => (
              <g key={t}>
                <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="#eef0f4" vectorEffect="non-scaling-stroke" />
                <text x={L - 6} y={y(t) + 3.5} textAnchor="end" fontSize={10} fill="#64748b">{formatINRCompact(t)}</text>
              </g>
            ))}
            {points.map((p, i) => (i % step === 0 || i === points.length - 1 ? (
              <text key={p.date} x={x(i)} y={H - 5} textAnchor={i === points.length - 1 ? "end" : i === 0 ? "start" : "middle"} fontSize={10} fill="#64748b">{formatDate(p.date).slice(0, 6)}</text>
            ) : null))}
            {area ? <path d={area} fill="#4338ca" fillOpacity={0.07} /> : null}
            <polyline points={line} fill="none" stroke="#4338ca" strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            {points.map((p, i) => (p.cas || i === points.length - 1 ? <circle key={p.date} cx={x(i)} cy={y(p.value)} r={cur === i ? 5 : 4} fill="#4338ca" stroke="#fff" strokeWidth={2} /> : null))}
            {cur != null ? <line x1={x(cur)} x2={x(cur)} y1={T} y2={H - B} stroke="#94a3b8" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" /> : null}
            {points.map((p, i) => (
              <rect key={`h-${p.date}`} x={x(i) - (W - L - R) / (2 * Math.max(1, points.length - 1))} y={T} width={(W - L - R) / Math.max(1, points.length - 1)} height={H - T - B}
                fill="transparent" tabIndex={0} aria-label={`${formatDate(p.date)}: ${formatINRCompact(p.value)} in funds${p.cas ? " (CAS)" : " (today, latest NAV)"}`}
                onMouseEnter={() => setAt(i)} onFocus={() => setAt(i)} onBlur={() => setAt(null)} />
            ))}
          </svg>
          {cur != null ? (
            <div aria-live="polite" className="pointer-events-none absolute top-0 rounded-md bg-ink px-2 py-1 text-[11.5px] leading-snug text-white shadow"
              style={{ left: `${Math.min(68, Math.max(0, (x(cur) / W) * 100 - 10))}%` }}>
              <b>{formatDate(points[cur].date)}</b> · {formatINRCompact(points[cur].value)}
              <div className="text-slate-300">{points[cur].cas ? "from the CAS" : "today, at the latest NAV"}</div>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
