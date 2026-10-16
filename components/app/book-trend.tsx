"use client";

import { useState } from "react";
import { formatINRCompact } from "@/lib/format";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const label = (m: string) => `${MON[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

/** Money in funds by month: one line, a crosshair and a tooltip on hover (or focus) of any month. */
export function BookTrend({ points }: { points: { month: string; value: number; clients: number }[] }) {
  const [at, setAt] = useState<number | null>(null);
  const W = 640, H = 220, L = 56, R = 12, T = 12, B = 26;
  const vals = points.map((p) => p.value);
  const max = Math.max(...vals, 1);
  const min = Math.min(...vals.filter((v) => v > 0), max);
  const pad = (max - min) * 0.15 || max * 0.1;
  const lo = Math.max(0, min - pad), hi = max + pad;
  const x = (i: number) => L + (i * (W - L - R)) / Math.max(1, points.length - 1);
  const y = (v: number) => T + ((hi - v) / (hi - lo || 1)) * (H - T - B);
  const ticks = [0, 1, 2, 3].map((k) => lo + ((hi - lo) * k) / 3);
  const first = points.findIndex((p) => p.value > 0);
  const shown = points.map((p, i) => ({ ...p, i })).filter((p) => p.i >= Math.max(0, first));
  const line = shown.map((p) => `${x(p.i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = shown.length ? `M${x(shown[0].i)},${y(lo)} L${line.replaceAll(" ", " L")} L${x(shown[shown.length - 1].i)},${y(lo)} Z` : "";
  const cur = at ?? null;
  const prev = cur != null && cur > 0 ? points[cur - 1] : null;

  return (
    <div className="relative" onMouseLeave={() => setAt(null)}>
      <svg role="img" aria-label={`Money in funds by month, ${label(points[0].month)} to ${label(points[points.length - 1].month)}: ${formatINRCompact(points[Math.max(0, first)]?.value ?? 0)} to ${formatINRCompact(points[points.length - 1].value)}`}
        viewBox={`0 0 ${W} ${H}`} className="h-auto w-full">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="#e2e8f0" strokeWidth={1} />
            <text x={L - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill="#64748b">{formatINRCompact(t)}</text>
          </g>
        ))}
        {points.map((p, i) => (i % 2 === 1 || i === points.length - 1 ? <text key={p.month} x={x(i)} y={H - 8} textAnchor="middle" fontSize={11} fill="#64748b">{MON[Number(p.month.slice(5, 7)) - 1]}</text> : null))}
        {area ? <path d={area} fill="#2a78d6" fillOpacity={0.08} /> : null}
        <polyline points={line} fill="none" stroke="#2a78d6" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {cur != null && points[cur].value > 0 ? (
          <>
            <line x1={x(cur)} x2={x(cur)} y1={T} y2={H - B} stroke="#94a3b8" strokeDasharray="3 3" />
            <circle cx={x(cur)} cy={y(points[cur].value)} r={5} fill="#2a78d6" stroke="#fff" strokeWidth={2} />
          </>
        ) : <circle cx={x(points.length - 1)} cy={y(points[points.length - 1].value)} r={4} fill="#2a78d6" />}
        {points.map((p, i) => (
          <rect key={p.month} x={x(i) - (W - L - R) / (2 * Math.max(1, points.length - 1))} y={T} width={(W - L - R) / Math.max(1, points.length - 1)} height={H - T - B}
            fill="transparent" tabIndex={0} aria-label={`${label(p.month)}: ${formatINRCompact(p.value)}`}
            onMouseEnter={() => setAt(i)} onFocus={() => setAt(i)} onBlur={() => setAt(null)} />
        ))}
      </svg>
      {cur != null && points[cur].value > 0 ? (
        <div className="pointer-events-none absolute top-1 rounded-md bg-ink px-2.5 py-1.5 text-xs leading-snug text-white shadow"
          style={{ left: `${Math.min(70, (x(cur) / W) * 100)}%` }}>
          <b>{label(points[cur].month)}{cur === points.length - 1 ? " · today" : ""}</b>
          <div>{formatINRCompact(points[cur].value)} in funds · {points[cur].clients} client{points[cur].clients === 1 ? "" : "s"}</div>
          {prev && prev.value > 0 ? <div className="text-slate-300">{points[cur].value >= prev.value ? "+" : "−"}{formatINRCompact(Math.abs(points[cur].value - prev.value))} vs {MON[Number(prev.month.slice(5, 7)) - 1]}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
