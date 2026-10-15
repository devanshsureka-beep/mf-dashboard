"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/form";

/** The list's search box: the list filters while typing (no Enter needed). */
export function LiveSearch({ defaultValue }: { defaultValue?: string }) {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const [q, setQ] = useState(defaultValue ?? "");
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => {
      const p = new URLSearchParams(params.toString());
      if (q.trim()) p.set("q", q.trim());
      else p.delete("q");
      const s = p.toString();
      router.replace(`${path}${s ? `?${s}` : ""}`, { scroll: false });
    }, 250);
    return () => clearTimeout(t);
    // Only typing starts a search; the URL changing because of it must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  return <Input name="q" placeholder="Name, client ID, phone, email…" value={q} onChange={(e) => setQ(e.target.value)} className="h-9 w-72" aria-label="Search" autoComplete="off" />;
}
