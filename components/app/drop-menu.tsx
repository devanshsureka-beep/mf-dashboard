"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** A button that opens a small menu of links; closes on outside click or Escape. */
export function DropMenu({ label, primary = false, align = "left", children }: { label: string; primary?: boolean; align?: "left" | "right"; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "inline-flex h-8 items-center gap-1 rounded-md px-3 text-[13px] font-medium",
          primary ? "bg-brand text-white hover:bg-brand-700" : "border border-border bg-white text-ink hover:bg-slate-50",
        )}
      >
        {label} <span aria-hidden className="text-[10px]">▾</span>
      </button>
      {open ? (
        <div role="menu" onClick={() => setOpen(false)} className={cn("absolute top-9 z-40 w-72 rounded-lg border border-border bg-white p-1.5 shadow-xl", align === "right" ? "right-0" : "left-0")}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function MenuHeading({ children }: { children: React.ReactNode }) {
  return <div className="px-2.5 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-[0.06em] text-muted first:pt-1">{children}</div>;
}

export function MenuItem({ href, children, hint, danger, download }: { href: string; children: React.ReactNode; hint?: React.ReactNode; danger?: boolean; download?: boolean }) {
  const cls = cn("block rounded-md px-2.5 py-1.5 text-[13px] hover:bg-slate-50", danger ? "text-red-700" : "text-ink");
  const body = (<>{children}{hint ? <div className="text-[11px] font-normal text-muted">{hint}</div> : null}</>);
  // Downloads and API routes are plain links (no prefetch).
  return download || href.startsWith("/api/")
    ? <a role="menuitem" href={href} download={download || undefined} className={cls}>{body}</a>
    : <Link role="menuitem" href={href} className={cls}>{body}</Link>;
}
