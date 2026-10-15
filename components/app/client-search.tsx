"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { searchClientsAction } from "@/app/(app)/search-actions";
import type { ClientHit } from "@/services/clients";

/** Find a client as you type: matches show under the box; Enter opens the highlighted one. */
export function ClientSearch() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<ClientHit[]>([]);
  const [searched, setSearched] = useState("");
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = q.trim();
    if (!term) return;
    let stale = false;
    const t = setTimeout(async () => {
      const found = await searchClientsAction(term);
      if (stale) return;
      setHits(found);
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
  const shown = term ? hits : [];
  const go = (href: string) => {
    setOpen(false);
    setQ("");
    setHits([]);
    router.push(href);
  };

  return (
    <div ref={box} className="relative" role="search">
      <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-sidebar-muted" aria-hidden />
      <input
        type="search"
        value={q}
        placeholder="Find client, ID, phone…"
        aria-label="Find a client"
        role="combobox"
        aria-expanded={open && Boolean(term)}
        aria-controls="client-search-results"
        autoComplete="off"
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, shown.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          else if (e.key === "Escape") setOpen(false);
          else if (e.key === "Enter" && term) {
            e.preventDefault();
            go(shown[active] ? `/clients/${shown[active].client_id}` : `/clients?q=${encodeURIComponent(term)}`);
          }
        }}
        className="h-9 w-full rounded-md border border-white/10 bg-white/5 pl-8 pr-2 text-sm text-white placeholder:text-sidebar-muted focus:border-brand-300 focus:outline-none"
      />
      {open && term ? (
        <div id="client-search-results" className="absolute left-0 right-0 z-50 mt-1 overflow-hidden rounded-lg border border-border bg-white text-ink shadow-xl" role="listbox">
          {shown.length ? shown.map((h, i) => (
            <button
              key={h.client_id}
              type="button"
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => go(`/clients/${h.client_id}`)}
              className={cn("block w-full px-3 py-2 text-left", i === active ? "bg-brand-50" : "bg-white")}
            >
              <div className="truncate text-sm font-medium">{h.full_name}</div>
              <div className="truncate text-[11px] text-muted">{h.client_code}{h.advisor_name ? ` · ${h.advisor_name}` : ""}{h.status !== "ACTIVE" ? ` · ${h.status.toLowerCase()}` : ""}</div>
            </button>
          )) : (
            <div className="px-3 py-2 text-xs text-muted">{searched === term ? "No client matches." : "Searching…"}</div>
          )}
          <button type="button" onClick={() => go(`/clients?q=${encodeURIComponent(term)}`)} className="block w-full border-t border-border px-3 py-1.5 text-left text-[11px] text-brand hover:bg-slate-50">
            All results in Clients →
          </button>
        </div>
      ) : null}
    </div>
  );
}
