import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";

const TONE_BAR = {
  default: "bg-transparent",
  attention: "bg-amber-400",
  danger: "bg-red-500",
  success: "bg-emerald-500",
} as const;

export function StatCard({
  label, value, hint, href, tone = "default", className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  href?: string;
  tone?: "default" | "attention" | "danger" | "success";
  className?: string;
}) {
  const body = (
    <div
      className={cn(
        "group relative h-full overflow-hidden rounded-xl border border-border bg-surface px-4 py-3.5 shadow-[0_1px_2px_rgba(16,24,40,0.04)]",
        href && "transition hover:-translate-y-px hover:border-brand-200 hover:shadow-md",
        className,
      )}
    >
      <span className={cn("absolute inset-y-0 left-0 w-1", TONE_BAR[tone])} aria-hidden />
      <div className="flex items-start justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">{label}</div>
        {href ? <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-muted opacity-0 transition group-hover:opacity-100" aria-hidden /> : null}
      </div>
      <div
        className={cn(
          "mt-1.5 text-2xl font-semibold tracking-tight num",
          tone === "attention" && "text-amber-700",
          tone === "danger" && "text-red-700",
          tone === "success" && "text-emerald-700",
        )}
      >
        {value}
      </div>
      {hint ? <div className="mt-0.5 text-xs text-muted">{hint}</div> : null}
    </div>
  );
  return href ? <Link href={href} className="block h-full">{body}</Link> : body;
}
