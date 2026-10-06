import { TransitionBar } from "@/components/ui/progress";
import { Money } from "./money";
import type { TransitionNumbers } from "@/types/domain";
import { cn } from "@/lib/utils";

/**
 * The core "Target / Advised / Executed / Pending / Yet to advise" block.
 * Numbers always come from the database views (never recomputed here).
 */
export function TransitionSummary({ side, n, className, compact }: { side: "SELL" | "BUY"; n: TransitionNumbers; className?: string; compact?: boolean }) {
  const title = side === "SELL" ? "Sell transition" : "Buy transition";
  const pct = n.target > 0 ? Math.round((n.executed / n.target) * 100) : 0;
  const cells: { label: string; value: number; cls?: string; help: string }[] = [
    { label: "Target", value: n.target, help: side === "SELL" ? "Planned exit (end state)" : "Planned deployment (end state)" },
    { label: "Advised", value: n.advised, cls: "text-blue-700", help: "Calls actually communicated to the client" },
    { label: "Executed", value: n.executed, cls: "text-emerald-700", help: "Confirmed executions" },
    { label: compact ? "Pending" : "Pending execution", value: n.pending, cls: "text-amber-700", help: "Advised − Executed" },
    { label: "Yet to advise", value: n.yetToAdvise, cls: "text-gray-700", help: "Target − Advised" },
  ];
  return (
    <div className={cn("rounded-lg border border-border bg-surface shadow-sm", compact ? "p-3" : "p-4", className)}>
      <div className={cn("flex items-center justify-between", compact ? "mb-2" : "mb-3")}>
        <h3 className={cn("text-sm font-semibold uppercase tracking-wide", side === "SELL" ? "text-red-700" : "text-emerald-700")}>{title}</h3>
        <span className="text-xs text-muted num">{pct}% executed</span>
      </div>
      <div className="grid grid-cols-5 gap-2">
        {cells.map((c) => (
          <div key={c.label} title={c.help}>
            <div className={cn("font-medium uppercase tracking-wide text-muted", compact ? "truncate text-[10px]" : "text-[11px]")}>{c.label}</div>
            <div className={cn("mt-0.5 font-semibold", compact ? "text-base" : "text-lg", c.cls)}>
              <Money value={c.value} />
            </div>
          </div>
        ))}
      </div>
      <TransitionBar className={compact ? "mt-2" : "mt-3"} target={n.target} executed={n.executed} pending={n.pending} />
      <div className={cn("mt-1.5 flex gap-4 text-[11px] text-muted", compact && "hidden")}>
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-emerald-500" /> Executed</span>
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-amber-400" /> Pending execution</span>
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-gray-200" /> Not yet executed / advised</span>
      </div>
    </div>
  );
}
