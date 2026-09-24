import { formatINR, formatINRCompact } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Compact rupees (₹15.78L) with the full figure (₹15,77,657) on hover. */
export function Money({ value, full, className }: { value: number | null | undefined; full?: boolean; className?: string }) {
  if (value === null || value === undefined) return <span className={cn("num text-muted", className)}>—</span>;
  return (
    <span className={cn("num", className)} title={formatINR(value, { decimals: true })}>
      {full ? formatINR(value) : formatINRCompact(value)}
    </span>
  );
}
