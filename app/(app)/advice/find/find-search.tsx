"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatINRCompact } from "@/lib/format";
import type { FundMatch } from "@/services/advise-desk";
import type { ClientHit } from "@/services/clients";
import { findSuggestAction } from "./actions";

type Hit = { kind: "fund"; f: FundMatch } | { kind: "client"; c: ClientHit };

/** One box for a fund (who holds it, whose plan has it) or a client. */
export function FindSearch({ initial = "" }: { initial?: string }) {
  const router = useRouter();
  const [q, setQ] = useState(initial);
  const [hits, setHits] = useState<Hit[]>([]);
  const [searched, setSearched] = useState("");
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return;
    let stale = false;
    const t = setTimeout(async () => {
      const r = await findSuggestAction(term);
      if (stale) return;
      setHits([...r.funds.map((f) => ({ kind: "fund" as const, f })), ...r.clients.map((c) => ({ kind: "client" as const, c }))]);
      setSearched(term);
      setActive(0);
    }, 150);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [q]);

  useEffect(() => {
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const term = q.trim();
  const shown = term.length >= 2 && searched === term ? hits : [];
  const href = (h: Hit) => (h.kind === "fund" ? `/advice/find?fund=${h.f.security_id}` : `/clients/${h.c.client_id}`);
  const go = (h: Hit) => {
    setOpen(false);
    router.push(href(h));
  };

  return (
    <div ref={box} className="relative" role="search">
      <Search className="pointer-events-none absolute left-3.5 top-3.5 h-5 w-5 text-brand" aria-hidden />
      <input
        type="search"
        value={q}
        placeholder="Search a fund, AMC, ISIN or client: see every client who holds it, advised or not"
        aria-label="Search a fund, AMC, ISIN or client"
        role="combobox"
        aria-expanded={open && shown.length > 0}
        aria-controls="find-results"
        autoComplete="off"
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, shown.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          else if (e.key === "Escape") setOpen(false);
          else if (e.key === "Enter" && shown[active]) { e.preventDefault(); go(shown[active]); }
        }}
        className="h-12 w-full rounded-xl border-2 border-brand bg-white pl-11 pr-3 text-[15px] focus:outline-none focus:ring-2 focus:ring-brand-200"
      />
      {open && term.length >= 2 ? (
        <div id="find-results" role="listbox" className="absolute left-0 right-0 z-40 mt-1 max-h-[26rem] overflow-y-auto rounded-xl border border-border bg-white shadow-xl">
          {shown.length === 0 ? <p className="px-4 py-3 text-sm text-muted">{searched === term ? "No fund a client holds or a plan has, and no client, matches." : "Searching…"}</p> : null}
          {shown.some((h) => h.kind === "fund") ? <div className="px-4 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Funds</div> : null}
          {shown.map((h, i) => h.kind !== "fund" ? null : (
            <button key={h.f.security_id} type="button" role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onClick={() => go(h)}
              className={cn("flex w-full flex-wrap items-baseline justify-between gap-2 px-4 py-2.5 text-left", i === active && "bg-brand-50")}>
              <span className="min-w-0 font-medium">{h.f.scheme_name}{h.f.isin ? <span className="ml-1.5 text-[11px] font-normal text-muted">{h.f.isin}</span> : null}</span>
              <span className="text-xs text-muted">
                {h.f.holders ? `held by ${h.f.holders} · ${formatINRCompact(h.f.held_value)}` : "not held"}{h.f.in_plans ? ` · in ${h.f.in_plans} plan${h.f.in_plans === 1 ? "" : "s"}` : ""}
              </span>
            </button>
          ))}
          {shown.some((h) => h.kind === "client") ? <div className="border-t border-border px-4 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Clients</div> : null}
          {shown.map((h, i) => h.kind !== "client" ? null : (
            <button key={h.c.client_id} type="button" role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onClick={() => go(h)}
              className={cn("flex w-full items-baseline justify-between gap-2 px-4 py-2.5 text-left", i === active && "bg-brand-50")}>
              <span className="font-medium">{h.c.full_name}</span>
              <span className="text-xs text-muted">{h.c.client_code}{h.c.advisor_name ? ` · ${h.c.advisor_name}` : ""}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A GET form that applies itself as soon as a field changes (no Filter button). */
export function AutoForm({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLFormElement>(null);
  return (
    <form ref={ref} method="get" className={className}
      onChange={(e) => {
        // Typed fields apply on Enter or when left (not on every key); selects and ticks at once.
        const t = e.target as unknown as HTMLInputElement;
        if (t.tagName === "SELECT" || t.type === "checkbox") ref.current?.requestSubmit();
      }}
      onBlur={(e) => {
        const t = e.target as unknown as HTMLInputElement;
        if (t.tagName === "INPUT" && t.type !== "checkbox" && t.value !== t.defaultValue) ref.current?.requestSubmit();
      }}>
      {children}
    </form>
  );
}
