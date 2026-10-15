import Link from "next/link";
import { cn } from "@/lib/utils";
import type { AppRole } from "@/types/domain";

type Tab = { key: string; href: string; label: string; roles?: AppRole[] };

/** Pages that live together under one menu item, shown as tabs. */
export const HUBS = {
  calls: [
    { key: "pending", href: "/executions/pending", label: "Waiting for clients" },
    { key: "ledger", href: "/advice", label: "All calls" },
    { key: "bulk", href: "/advice/bulk", label: "Call many clients", roles: ["ADMIN", "ADVISOR"] },
  ],
  onboard: [
    { key: "client", href: "/onboard", label: "Client onboard · CAS + report" },
    { key: "new", href: "/onboard/new", label: "New MF user · report only" },
  ],
  admin: [
    { key: "team", href: "/admin/users", label: "Team & assignments" },
    { key: "audit", href: "/audit", label: "Audit log" },
    { key: "deleted", href: "/clients?deleted=1", label: "Deleted clients" },
  ],
} satisfies Record<string, Tab[]>;

export function HubTabs({ hub, active, role, counts }: { hub: keyof typeof HUBS; active: string; role: AppRole; counts?: Record<string, number> }) {
  const tabs = (HUBS[hub] as Tab[]).filter((t) => !t.roles || t.roles.includes(role));
  return (
    <nav aria-label="Sections" className="-mt-3 mb-4 flex gap-0.5 overflow-x-auto border-b border-border">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === active ? "page" : undefined}
          className={cn(
            "-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-[13.5px]",
            t.key === active ? "border-brand font-semibold text-brand" : "border-transparent text-slate-600 hover:border-border hover:text-ink",
          )}
        >
          {t.label}
          {counts?.[t.key] ? <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 text-[11px] font-semibold text-amber-900">{counts[t.key]}</span> : null}
        </Link>
      ))}
    </nav>
  );
}
