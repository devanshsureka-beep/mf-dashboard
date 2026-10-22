import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Active (● green) = we have advised the client at least once; Inactive (○ grey) = not advised yet
 * (v_client_activity). Shown before the client's name wherever it is listed; hover for the reason.
 */
export function ActiveDot({ active, since, className }: { active: boolean | null | undefined; since?: string | Date | null; className?: string }) {
  if (active == null) return null;
  const label = active ? `Active · first call ${formatDate(since ?? null)}` : "Inactive · no call yet";
  return (
    <span
      role="img"
      aria-label={active ? "Active" : "Inactive"}
      title={label}
      className={cn("mr-1.5 inline-block h-2 w-2 shrink-0 rounded-full align-middle", active ? "bg-emerald-500" : "border-[1.5px] border-slate-400 bg-transparent", className)}
    />
  );
}
