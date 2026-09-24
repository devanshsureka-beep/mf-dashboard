import { cn } from "@/lib/utils";

/** Stacked progress: executed (solid) + pending (hatched) out of target. */
export function TransitionBar({ target, executed, pending, className }: { target: number; executed: number; pending: number; className?: string }) {
  const t = target > 0 ? target : Math.max(executed + pending, 1);
  const e = Math.min((executed / t) * 100, 100);
  const p = Math.min((pending / t) * 100, 100 - e);
  return (
    <div className={cn("h-2 w-full overflow-hidden rounded-full bg-gray-100", className)} title={`Executed ${e.toFixed(0)}%, pending ${p.toFixed(0)}%`}>
      <div className="flex h-full">
        <div className="h-full bg-emerald-500" style={{ width: `${e}%` }} />
        <div className="h-full bg-amber-400" style={{ width: `${p}%` }} />
      </div>
    </div>
  );
}

export function Progress({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-gray-100", className)}>
      <div className="h-full bg-brand" style={{ width: `${Math.max(0, Math.min(value, 100))}%` }} />
    </div>
  );
}
