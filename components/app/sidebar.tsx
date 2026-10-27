"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { BarChart3, LayoutDashboard, Users, PhoneCall, Inbox, ScrollText, ShieldCheck, LogOut, UserPlus, Menu, X, KeyRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { PAGES, ROLE_LABELS } from "@/lib/brand";
import { BrandMark } from "@/components/app/brand-mark";
import { ClientSearch } from "@/components/app/client-search";
import type { AppRole } from "@/types/domain";

type NavItem = {
  href: string; label: string; icon: typeof Users; roles?: AppRole[]; exact?: boolean;
  /** Other paths that belong to this item. */
  also?: string[]; badge?: "calls" | "cas";
};

const SECTIONS: { title: string; items: NavItem[] }[] = [
  {
    title: "Work",
    items: [
      { href: "/overview", label: PAGES.overview, icon: BarChart3 },
      { href: "/", label: PAGES.today, icon: LayoutDashboard, exact: true },
      { href: "/clients", label: PAGES.clients, icon: Users },
      { href: "/advice/find", label: PAGES.calls, icon: PhoneCall, also: ["/advice", "/executions"], badge: "calls" },
      { href: "/reconciliation", label: PAGES.casInbox, icon: Inbox, also: ["/cas", "/snapshots"], badge: "cas" },
    ],
  },
  { title: "Add", items: [{ href: "/onboard", label: PAGES.onboardHub, icon: UserPlus }] },
  {
    title: "Admin",
    items: [
      { href: "/admin/users", label: "Team & access", icon: ShieldCheck, roles: ["ADMIN"], also: ["/admin"] },
      { href: "/audit", label: PAGES.auditLog, icon: ScrollText, roles: ["ADMIN"] },
    ],
  },
];

function initials(name: string) {
  const parts = name.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "U";
}

export function Sidebar({ name, role, signOut, counts, passwordLink = false }: { name: string; role: AppRole; signOut: () => Promise<void>; counts?: { awaitingExecution: number; casInbox: number }; passwordLink?: boolean }) {
  const path = usePathname();
  // The menu belongs to the page it was opened on: navigating closes it.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === path;
  const setOpen = (next: boolean | ((o: boolean) => boolean)) =>
    setOpenOn((typeof next === "function" ? next(open) : next) ? path : null);

  const under = (p: string) => path === p || path.startsWith(`${p}/`);
  // The most specific menu entry wins.
  const activeHref = SECTIONS.flatMap((x) => x.items)
    .flatMap((n) => (n.exact ? (path === n.href ? [{ n, len: n.href.length }] : []) : [n.href, ...(n.also ?? [])].filter(under).map((p) => ({ n, len: p.length }))))
    .sort((a, b) => b.len - a.len)[0]?.n.href;
  const badgeOf = (n: NavItem) => (n.badge === "calls" ? counts?.awaitingExecution ?? 0 : n.badge === "cas" ? counts?.casInbox ?? 0 : 0);

  const nav = (
    <nav className="flex-1 space-y-4 overflow-y-auto px-3 py-3">
      <ClientSearch />
      {SECTIONS.map((s) => {
        const items = s.items.filter((n) => !n.roles || n.roles.includes(role));
        if (!items.length) return null;
        return (
          <div key={s.title}>
            <div className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-sidebar-muted">{s.title}</div>
            <div className="space-y-0.5">
              {items.map((n) => {
                const active = n.href === activeHref;
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
                    <span className="flex-1">{n.label}</span>
                    {badgeOf(n) > 0 ? (
                      <span className={cn("rounded-full px-1.5 text-[11px] font-semibold", n.badge === "cas" ? "bg-red-500 text-white" : "bg-amber-400 text-amber-950")}>{badgeOf(n)}</span>
                    ) : null}
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
        {passwordLink ? (
          <Link href="/account/password" className="rounded-md p-1.5 text-sidebar-muted hover:bg-white/10 hover:text-white" title="Change password" aria-label="Change password">
            <KeyRound className="h-4 w-4" />
          </Link>
        ) : null}
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
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-white/10 bg-sidebar px-4 lg:hidden print:hidden">
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
          "fixed inset-y-0 left-0 z-40 flex w-60 flex-col bg-sidebar transition-transform lg:translate-x-0 print:hidden",
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
