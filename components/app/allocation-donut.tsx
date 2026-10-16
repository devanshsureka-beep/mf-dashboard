import { formatINRCompact } from "@/lib/format";
import type { Slice } from "@/lib/domain/book";

/** Categorical slots in a fixed order (validated for colour-blind separation on a light surface). */
const SLOTS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
const OTHER = "#94a3b8";

/** A donut with a labelled legend (name, amount, share), so no slice relies on colour alone. */
export function AllocationDonut({ slices, total }: { slices: Slice[]; total: number }) {
  const r = 70, w = 22, c = 2 * Math.PI * r;
  const starts = slices.map((_, i) => slices.slice(0, i).reduce((t, s) => t + s.share * c, 0));
  const color = (s: Slice, i: number) => (s.label === "Other" ? OTHER : SLOTS[i % SLOTS.length]);
  return (
    <div className="grid items-center gap-5 sm:grid-cols-[180px_minmax(0,1fr)]">
      <svg role="img" aria-label={`Allocation: ${slices.map((s) => `${s.label} ${Math.round(s.share * 100)}%`).join(", ")}`} viewBox="0 0 180 180" className="mx-auto h-44 w-44">
        <g transform="rotate(-90 90 90)">
          {slices.map((s, i) => {
            // A 2px gap between slices, but every slice stays visible (at least 2px).
            const len = Math.max(2, s.share * c - (slices.length > 1 && s.share * c > 6 ? 2 : 0));
            return (
              <circle key={s.label} cx={90} cy={90} r={r} fill="none" stroke={color(s, i)} strokeWidth={w}
                strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-starts[i]}>
                <title>{`${s.label}: ${formatINRCompact(s.value)} · ${(s.share * 100).toFixed(1)}%`}</title>
              </circle>
            );
          })}
        </g>
        <text x={90} y={86} textAnchor="middle" fontSize={11} fill="#64748b">IN FUNDS</text>
        <text x={90} y={105} textAnchor="middle" fontSize={16} fontWeight={700} fill="#0f172a">{formatINRCompact(total)}</text>
      </svg>
      <ul className="space-y-1.5 text-[13px]">
        {slices.map((s, i) => (
          <li key={s.label} className="grid grid-cols-[12px_minmax(0,1fr)_auto_48px] items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: color(s, i) }} aria-hidden />
            <span className="truncate">{s.label}</span>
            <span className="text-muted num">{formatINRCompact(s.value)}</span>
            <b className="text-right num">{(s.share * 100).toFixed(1)}%</b>
          </li>
        ))}
      </ul>
    </div>
  );
}
