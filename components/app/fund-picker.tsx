"use client";

import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { formatDate, formatNav } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { FundOption } from "@/services/fund-search";

export interface PickedFund { value: string; scheme_name: string; nav: number | null }

/**
 * Type-to-search over every mutual fund (AMFI list + funds already used).
 * Funds the client holds can be offered first via `suggestions`.
 */
export function FundPicker({
  search, value, onChange, suggestions = [], placeholder = "Search any fund: name, AMC or ISIN…", className,
}: {
  search: (q: string) => Promise<FundOption[]>;
  value: PickedFund | null;
  onChange: (f: PickedFund | null) => void;
  suggestions?: { value: string; scheme_name: string; nav: number | null; note?: string }[];
  placeholder?: string;
  className?: string;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<FundOption[]>([]);
  const [loading, setLoading] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (q.trim().length < 2) return;
    let live = true;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await search(q);
        if (live) setResults(r);
      } finally {
        if (live) setLoading(false);
      }
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, search]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  if (value) {
    return (
      <div className={cn("flex h-8 min-w-0 items-center gap-2 rounded-md border border-brand-200 bg-brand-50 px-2 text-xs", className)}>
        <span className="min-w-0 flex-1 truncate font-medium text-ink" title={value.scheme_name}>{value.scheme_name}</span>
        {value.nav ? <span className="shrink-0 text-muted num">NAV {formatNav(value.nav)}</span> : null}
        <button type="button" onClick={() => onChange(null)} className="shrink-0 rounded p-0.5 text-muted hover:bg-white hover:text-ink" aria-label="Change fund">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  const showSuggestions = q.trim().length < 2 && suggestions.length > 0;
  return (
    <div ref={box} className={cn("relative min-w-0", className)}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          className="h-8 w-full rounded-md border border-border bg-white pl-7 pr-2 text-xs focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20"
          aria-label="Search funds"
        />
      </div>
      {open && (showSuggestions || q.trim().length >= 2) ? (
        <div className="absolute z-30 mt-1 max-h-80 w-[min(36rem,90vw)] overflow-y-auto rounded-lg border border-border bg-white py-1 shadow-lg">
          {showSuggestions ? (
            <>
              <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">Held by this client</div>
              {suggestions.map((s) => (
                <button key={s.value} type="button" onClick={() => { onChange({ value: s.value, scheme_name: s.scheme_name, nav: s.nav }); setOpen(false); }}
                  className="block w-full px-3 py-1.5 text-left text-xs hover:bg-brand-50">
                  <div className="truncate font-medium">{s.scheme_name}</div>
                  {s.note ? <div className="text-[11px] text-muted">{s.note}</div> : null}
                </button>
              ))}
              <div className="border-t border-border px-3 py-1.5 text-[11px] text-muted">Type to search all funds…</div>
            </>
          ) : loading && !results.length ? (
            <div className="px-3 py-2 text-xs text-muted">Searching…</div>
          ) : results.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted">No fund matches “{q}”.</div>
          ) : (
            results.map((r) => (
              <button key={r.value} type="button" onClick={() => { onChange({ value: r.value, scheme_name: r.scheme_name, nav: r.nav }); setOpen(false); setQ(""); }}
                className="block w-full px-3 py-1.5 text-left text-xs hover:bg-brand-50">
                <div className="truncate font-medium">{r.scheme_name}</div>
                <div className="flex flex-wrap gap-x-2 text-[11px] text-muted">
                  {r.amc ? <span>{r.amc}</span> : null}
                  {r.category ? <span>{r.category}</span> : null}
                  {r.isin ? <span className="num">{r.isin}</span> : <span className="text-amber-700">no ISIN yet</span>}
                  {r.nav ? <span className="num">NAV {formatNav(r.nav)}{r.nav_date ? ` · ${formatDate(r.nav_date)}` : ""}</span> : null}
                </div>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
