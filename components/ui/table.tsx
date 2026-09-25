import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Table({ className, ...props }: ComponentProps<"table">) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn("w-full border-collapse text-sm", className)} {...props} />
    </div>
  );
}
export function THead({ className, ...props }: ComponentProps<"thead">) {
  return <thead className={cn("sticky top-0 z-10 bg-slate-50/90 text-left text-[11px] uppercase tracking-[0.06em] text-muted backdrop-blur", className)} {...props} />;
}
export function TBody(props: ComponentProps<"tbody">) {
  return <tbody {...props} />;
}
export function TR({ className, ...props }: ComponentProps<"tr">) {
  return <tr className={cn("border-b border-border/70 last:border-0 transition-colors hover:bg-brand-50/40", className)} {...props} />;
}
export function TH({ className, ...props }: ComponentProps<"th">) {
  return <th className={cn("px-3 py-2.5 font-semibold whitespace-nowrap", className)} {...props} />;
}
export function TD({ className, ...props }: ComponentProps<"td">) {
  return <td className={cn("px-3 py-2.5 align-top", className)} {...props} />;
}
