"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  LayoutDashboard, Users, PhoneCall, Hourglass, FileSearch, ScrollText, ShieldCheck, LogOut, UserPlus, FileStack, ClipboardCheck,
  Menu, X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { PAGES, ROLE_LABELS } from "@/lib/brand";
import { BrandMark } from "@/components/app/brand-mark";
import type { AppRole } from "@/types/domain";

type NavItem = { href: string; label: string; icon: typeof Users; roles?: AppRole[]; exact?: boolean };

const SECTIONS: { title: string; items: NavItem[] }[] = [
  {
    title: "Daily desk",
    items: [
      { href: "/", label: PAGES.overview, icon: LayoutDashboard, exact: true },
      { href: "/advice", label: PAGES.callLedger, icon: PhoneCall },
      { href: "/executions/pending", label: PAGES.pendingExecutions, icon: Hourglass },
    ],
  },
  {
    title: "Clients",
    items: [
      { href: "/clients", label: PAGES.clients, icon: Users },
      { href: "/onboard", label: PAGES.onboard, icon: UserPlus, roles: ["ADMIN", "ADVISOR"], exact: true },
      { href: "/onboard/check", label: PAGES.documentCheck, icon: ClipboardCheck },
    ],
  },
  {
    title: "CAS",
    items: [
      { href: "/cas/bulk", label: PAGES.bulkCas, icon: FileStack },
      { href: "/reconciliation", label: PAGES.casMatching, icon: FileSearch },
    ],
  },
  {
    title: "Admin",
    items: [
      { href: "/audit", label: PAGES.auditLog, icon: ScrollText, roles: ["ADMIN"] },
      { href: "/admin/users", label: PAGES.team, icon: ShieldCheck, roles: ["ADMIN"] },
    ],
  },
];

function initials(name: string) {
  const parts = name.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "U";
}

export function Sidebar({ name, role, signOut }: { name: string; role: AppRole; signOut: () => Promise<void> }) {
  const path = usePathname();
  // The menu belongs to the page it was opened on: navigating closes it.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === path;
  const setOpen = (next: boolean | ((o: boolean) => boolean)) =>
    setOpenOn((typeof next === "function" ? next(open) : next) ? path : null);

  const nav = (
    <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
      {SECTIONS.map((s) => {
        const items = s.items.filter((n) => !n.roles || n.roles.includes(role));
        if (!items.length) return null;
        return (
          <div key={s.title}>
            <div className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-sidebar-muted">{s.title}</div>
            <div className="space-y-0.5">
              {items.map((n) => {
                const active = n.exact ? path === n.href : path === n.href || path.startsWith(`${n.href}/`);
                const Icon = n.icon;
                return (
                  <Link
                    key={n.href}
                    href={n.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "group relative flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
                      active ? "bg-white/10 font-medium text-white" : "text-sidebar-ink hover:bg-white/5 hover:text-white",
                    )}
                  >
                    {active ? <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-brand-300" aria-hidden /> : null}
                    <Icon className={cn("h-4 w-4 shrink-0", active ? "text-brand-200" : "text-sidebar-muted group-hover:text-sidebar-ink")} />
                    {n.label}
                  </Link>
                );
              })}
            </div>
          </div>
        );
      })}
    </nav>
  );

  const footer = (
    <div className="border-t border-white/10 p-3">
      <div className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-xs font-semibold text-white">{initials(name)}</div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-white" title={name}>{name}</div>
          <div className="text-[11px] text-sidebar-muted">{ROLE_LABELS[role] ?? role}</div>
        </div>
        <form action={signOut}>
          <button className="rounded-md p-1.5 text-sidebar-muted hover:bg-white/10 hover:text-white" type="submit" title="Sign out" aria-label="Sign out">
            <LogOut className="h-4 w-4" />
          </button>
        </form>
      </div>
    </div>
  );

  return (
    <>
      {/* Phone / tablet top bar */}
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-white/10 bg-sidebar px-4 lg:hidden">
        <BrandMark />
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="rounded-md p-2 text-sidebar-ink hover:bg-white/10"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </header>
      {open ? <div className="fixed inset-0 z-30 bg-black/40 lg:hidden" onClick={() => setOpen(false)} aria-hidden /> : null}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-64 flex-col bg-sidebar transition-transform lg:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex h-16 items-center border-b border-white/10 px-4">
          <BrandMark />
        </div>
        {nav}
        {footer}
      </aside>
    </>
  );
}
