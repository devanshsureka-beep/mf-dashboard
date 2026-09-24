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
  return <thead className={cn("sticky top-0 z-10 bg-gray-50 text-left text-xs uppercase tracking-wide text-muted", className)} {...props} />;
}
export function TBody(props: ComponentProps<"tbody">) {
  return <tbody {...props} />;
}
export function TR({ className, ...props }: ComponentProps<"tr">) {
  return <tr className={cn("border-b border-border last:border-0 hover:bg-gray-50/60", className)} {...props} />;
}
export function TH({ className, ...props }: ComponentProps<"th">) {
  return <th className={cn("px-3 py-2 font-medium whitespace-nowrap", className)} {...props} />;
}
export function TD({ className, ...props }: ComponentProps<"td">) {
  return <td className={cn("px-3 py-2 align-top", className)} {...props} />;
}
