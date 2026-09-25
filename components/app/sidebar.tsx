"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard, Users, PhoneCall, Hourglass, FileSearch, ScrollText, ShieldCheck, LogOut, UserPlus, FileStack, ClipboardCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { AppRole } from "@/types/domain";

const NAV: { href: string; label: string; icon: typeof Users; roles?: AppRole[] }[] = [
  { href: "/", label: "Command Centre", icon: LayoutDashboard },
  { href: "/onboard/check", label: "Check Documents", icon: ClipboardCheck },
  { href: "/onboard", label: "Onboard Client", icon: UserPlus, roles: ["ADMIN", "ADVISOR"] },
  { href: "/clients", label: "Clients", icon: Users },
  { href: "/advice", label: "Advice Call Ledger", icon: PhoneCall },
  { href: "/executions/pending", label: "Pending Executions", icon: Hourglass },
  { href: "/cas/bulk", label: "Bulk CAS Upload", icon: FileStack },
  { href: "/reconciliation", label: "CAS & Reconciliation", icon: FileSearch },
  { href: "/audit", label: "Audit Log", icon: ScrollText, roles: ["ADMIN"] },
  { href: "/admin/users", label: "Users & Access", icon: ShieldCheck, roles: ["ADMIN"] },
];

export function Sidebar({ name, role, signOut }: { name: string; role: AppRole; signOut: () => Promise<void> }) {
  const path = usePathname();
  return (
    <aside className="fixed inset-y-0 left-0 z-20 flex w-60 flex-col border-r border-border bg-white">
      <div className="flex h-14 items-center gap-2 border-b border-border px-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-brand text-xs font-bold text-white">MN</div>
        <div className="leading-tight">
          <div className="text-sm font-semibold">MN Advisory</div>
          <div className="text-[11px] text-muted">Operations dashboard</div>
        </div>
      </div>
      <nav className="flex-1 space-y-0.5 p-2">
        {NAV.filter((n) => !n.roles || n.roles.includes(role)).map((n) => {
          const active = n.href === "/" || n.href === "/onboard" ? path === n.href : path.startsWith(n.href);
          const Icon = n.icon;
          return (
            <Link
              key={n.href}
              href={n.href}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm",
                active ? "bg-brand-soft font-medium text-brand" : "text-gray-700 hover:bg-gray-50",
              )}
            >
              <Icon className="h-4 w-4" /> {n.label}
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-border p-3">
        <div className="text-sm font-medium">{name}</div>
        <div className="text-xs text-muted">{role}</div>
        <form action={signOut}>
          <button className="mt-2 flex items-center gap-1.5 text-xs text-muted hover:text-ink" type="submit">
            <LogOut className="h-3.5 w-3.5" /> Sign out
          </button>
        </form>
      </div>
    </aside>
  );
}
