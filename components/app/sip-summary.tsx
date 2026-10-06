import Link from "next/link";
import { TransitionBar } from "@/components/ui/progress";
import { Money } from "./money";
import type { ClientSip } from "@/services/sip";
import { cn } from "@/lib/utils";

/**
 * SIP transition next to the lump-sum ones. Monthly amounts for the plan's SIP
 * lines; "Invested so far" is only what SIP instalments seen in CAS have put
 * in since the line was advised (no projection). Numbers come from v_client_sip.
 */
export function SipSummary({ s, planHref, className, compact }: { s: ClientSip; planHref?: string | null; className?: string; compact?: boolean }) {
  const cells: { label: string; value: number; cls?: string; help: string; suffix?: string }[] = [
    { label: "SIP target", value: s.sip_monthly_target, help: "SIP starts and changes in the plan, per month", suffix: "/mo" },
    { label: "Advised", value: s.sip_monthly_advised, cls: "text-blue-700", help: "SIP lines told to the client", suffix: "/mo" },
    { label: "Started", value: s.sip_monthly_started, cls: "text-emerald-700", help: "SIP lines seen running in a CAS", suffix: "/mo" },
    { label: "Yet to advise", value: s.sip_monthly_yet_to_advise, cls: "text-gray-700", help: "SIP lines not yet told to the client", suffix: "/mo" },
    { label: "Invested so far", value: s.sip_invested, cls: "text-emerald-700", help: "SIP instalments seen in CAS since each line was advised" },
  ];
  return (
    <div className={cn("rounded-lg border border-border bg-surface shadow-sm", compact ? "p-3" : "p-4", className)}>
      <div className={cn("flex flex-wrap items-center justify-between gap-2", compact ? "mb-2" : "mb-3")}>
        <h3 className="text-sm font-semibold uppercase tracking-wide text-violet-700">SIP transition{compact ? <span className="ml-1 text-[10px] font-normal normal-case text-muted">per month</span> : null}</h3>
        <span className="text-xs text-muted">
          {s.sips_to_stop ? `${s.sips_stopped}/${s.sips_to_stop} SIP stop(s) done · ` : ""}
          {planHref ? <Link href={planHref} className="text-brand hover:underline">{compact ? "SIP details →" : "Change lump sum ↔ SIP in the plan"}</Link> : null}
        </span>
      </div>
      <div className={cn("grid gap-2", compact ? "grid-cols-5" : "grid-cols-2 sm:grid-cols-5")}>
        {(compact ? [cells[0], cells[1], cells[2], cells[3], cells[4]] : cells).map((c) => (
          <div key={c.label} title={c.help}>
            <div className={cn("font-medium uppercase tracking-wide text-muted", compact ? "truncate text-[10px]" : "text-[11px]")}>{compact && c.label === "Invested so far" ? "Invested" : c.label}</div>
            <div className={cn("mt-0.5 font-semibold", compact ? "text-base" : "text-lg", c.cls)}>
              <Money value={c.value} />{c.suffix && !compact ? <span className="text-xs font-normal text-muted">{c.suffix}</span> : null}
            </div>
          </div>
        ))}
      </div>
      <TransitionBar className={compact ? "mt-2" : "mt-3"} target={s.sip_monthly_target} executed={s.sip_monthly_started} pending={Math.max(s.sip_monthly_advised - s.sip_monthly_started, 0)} />
      <div className={cn("mt-3 flex flex-wrap items-baseline gap-x-2 rounded-md bg-slate-50 px-3 text-sm ring-1 ring-border", compact ? "mt-2 py-1 text-xs" : "py-2")}>
        <span className="text-muted">Invested under the plan</span>
        <span className="font-semibold"><Money value={s.total_invested_under_plan} /></span>
        <span className="text-xs text-muted">= lump sum bought <Money value={s.lumpsum_buy_executed} /> + SIP invested <Money value={s.sip_invested} /></span>
      </div>
    </div>
  );
}
