import { BRAND } from "@/lib/brand";
import { cn } from "@/lib/utils";

/** Logo tile + wordmark. `tone="dark"` for the navy sidebar, `"light"` for white surfaces. */
export function BrandMark({ tone = "dark", size = "md", className }: { tone?: "dark" | "light"; size?: "md" | "lg"; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <div
        className={cn(
          "flex shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-brand-400 to-brand-700 font-bold text-white shadow-sm ring-1 ring-white/10",
          size === "lg" ? "h-11 w-11 text-lg" : "h-9 w-9 text-base",
        )}
        aria-hidden
      >
        U
      </div>
      <div className="min-w-0 leading-tight">
        <div className={cn("flex items-center gap-1.5 font-semibold", size === "lg" ? "text-lg" : "text-sm", tone === "dark" ? "text-white" : "text-ink")}>
          {BRAND.company} <span className={tone === "dark" ? "text-brand-200" : "text-brand-600"}>{BRAND.product}</span>
        </div>
        <div className={cn("text-[11px] font-medium uppercase tracking-[0.08em]", tone === "dark" ? "text-sidebar-muted" : "text-muted")}>
          {BRAND.desk}
        </div>
      </div>
    </div>
  );
}
