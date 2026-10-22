import Link from "next/link";
import { formatDate, formatINRCompact } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ActiveDot } from "@/components/app/active-dot";
import type { DraftPlanRow } from "@/services/plans";

/** What kind of draft this is, in the desk's words. */
export function draftKind(d: DraftPlanRow): string {
  if (d.plan_kind === "ADDITIONAL") return `Additional money${d.fresh_money ? ` ${formatINRCompact(d.fresh_money)}` : ""}`;
  return d.has_active_plan ? "New full plan (replaces the current one)" : "First plan";
}

/** One line on what the draft moves. */
export function draftMoves(d: DraftPlanRow): string {
  const parts = [
    d.sells ? `${d.sells} sell${d.sells === 1 ? "" : "s"} ${formatINRCompact(d.sell_total)}` : null,
    d.buys ? `${d.buys} buy${d.buys === 1 ? "" : "s"} ${formatINRCompact(d.buy_total)}` : null,
    d.sip_lines ? `${d.sip_lines} SIP line${d.sip_lines === 1 ? "" : "s"}` : null,
    d.keeps ? `${d.keeps} keep` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "No lines yet";
}

/** What is left before the draft can be approved, and the button for it. */
export function draftNext(d: DraftPlanRow): { text: string; tone: "amber" | "green"; cta: string } {
  if (d.open_questions) return { text: `${d.open_questions} question${d.open_questions === 1 ? "" : "s"} to answer`, tone: "amber", cta: `Answer ${d.open_questions} question${d.open_questions === 1 ? "" : "s"}` };
  if (d.needs_review) return { text: `${d.needs_review} line${d.needs_review === 1 ? "" : "s"} to check`, tone: "amber", cta: "Check lines" };
  return { text: "Ready to approve", tone: "green", cta: "Review & approve" };
}

const daysSince = (d: Date) => Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000));

export const draftHref = (d: DraftPlanRow) => `/clients/${d.client_id}/plans/${d.plan_id}${d.open_questions ? "#questions" : ""}`;

/** Drafts waiting for approval: each row opens its draft plan. */
export function DraftList({ rows, compact = false, act }: {
  rows: DraftPlanRow[]; compact?: boolean;
  /** Active / inactive by client (the dot before the name). */
  act?: Map<string, { is_active: boolean; first_advised_at: string | null }>;
}) {
  if (!rows.length) {
    return <p className="rounded-xl border border-dashed border-border bg-white p-6 text-center text-sm text-muted">No drafts waiting. A client onboarded from a CAS and a report opens here as a draft.</p>;
  }
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
      {rows.map((d) => {
        const next = draftNext(d);
        const age = daysSince(d.created_at);
        return (
          <li key={d.plan_id}>
            <Link href={draftHref(d)} className={cn("grid items-center gap-x-4 gap-y-1 px-4 py-3 text-[13px] hover:bg-slate-50", compact ? "sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1.6fr)_auto]" : "sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1.7fr)_minmax(0,0.9fr)_auto]")}>
              <div className="min-w-0">
                <div className="truncate font-semibold text-ink"><ActiveDot active={act?.get(d.client_id)?.is_active} since={act?.get(d.client_id)?.first_advised_at} />{d.client_name} <span className="text-xs font-normal text-muted">{d.client_code}</span></div>
                <div className="truncate text-xs text-muted">{draftKind(d)} · report {formatDate(d.plan_date)}</div>
              </div>
              <div className="min-w-0 truncate text-xs text-slate-700">{draftMoves(d)}</div>
              {compact ? null : (
                <div className="text-xs text-muted">{age === 0 ? "drafted today" : `waiting ${age} day${age === 1 ? "" : "s"}`}{d.advisor_name ? ` · ${d.advisor_name}` : ""}</div>
              )}
              <div className="flex items-center justify-end gap-3 whitespace-nowrap">
                <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", next.tone === "green" ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-900")}>{next.text}</span>
                <span className="text-xs font-medium text-brand">{next.cta} →</span>
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
