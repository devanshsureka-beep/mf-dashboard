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
export function SipSummary({ s, planHref, className }: { s: ClientSip; planHref?: string | null; className?: string }) {
  const cells: { label: string; value: number; cls?: string; help: string; suffix?: string }[] = [
    { label: "SIP target", value: s.sip_monthly_target, help: "SIP starts and changes in the plan, per month", suffix: "/mo" },
    { label: "Advised", value: s.sip_monthly_advised, cls: "text-blue-700", help: "SIP lines told to the client", suffix: "/mo" },
    { label: "Started", value: s.sip_monthly_started, cls: "text-emerald-700", help: "SIP lines seen running in a CAS", suffix: "/mo" },
    { label: "Yet to advise", value: s.sip_monthly_yet_to_advise, cls: "text-gray-700", help: "SIP lines not yet told to the client", suffix: "/mo" },
    { label: "Invested so far", value: s.sip_invested, cls: "text-emerald-700", help: "SIP instalments seen in CAS since each line was advised" },
  ];
  return (
    <div className={cn("rounded-lg border border-border bg-surface p-4 shadow-sm", className)}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-violet-700">SIP transition</h3>
        <span className="text-xs text-muted">
          {s.sips_to_stop ? `${s.sips_stopped}/${s.sips_to_stop} SIP stop(s) done · ` : ""}
          {planHref ? <Link href={planHref} className="text-brand hover:underline">Change lump sum ↔ SIP in the plan</Link> : null}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {cells.map((c) => (
          <div key={c.label} title={c.help}>
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted">{c.label}</div>
            <div className={cn("mt-0.5 text-lg font-semibold", c.cls)}>
              <Money value={c.value} />{c.suffix ? <span className="text-xs font-normal text-muted">{c.suffix}</span> : null}
            </div>
          </div>
        ))}
      </div>
      <TransitionBar className="mt-3" target={s.sip_monthly_target} executed={s.sip_monthly_started} pending={Math.max(s.sip_monthly_advised - s.sip_monthly_started, 0)} />
      <div className="mt-3 flex flex-wrap items-baseline gap-x-2 rounded-md bg-slate-50 px-3 py-2 text-sm ring-1 ring-border">
        <span className="text-muted">Invested under the plan</span>
        <span className="font-semibold"><Money value={s.total_invested_under_plan} /></span>
        <span className="text-xs text-muted">= lump sum bought <Money value={s.lumpsum_buy_executed} /> + SIP invested <Money value={s.sip_invested} /></span>
      </div>
    </div>
  );
}
