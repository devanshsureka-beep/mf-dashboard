import Link from "next/link";
import { cn } from "@/lib/utils";

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
        "h-full rounded-lg border bg-surface px-4 py-3 shadow-sm",
        tone === "attention" ? "border-amber-200" : tone === "danger" ? "border-red-200" : tone === "success" ? "border-emerald-200" : "border-border",
        href && "transition-colors hover:border-brand/40",
        className,
      )}
    >
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div
        className={cn(
          "mt-1 text-2xl font-semibold num",
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
