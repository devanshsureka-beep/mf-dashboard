import Link from "next/link";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { recheckSipAction } from "../actions";
import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { Money } from "@/components/app/money";
import { SipStatusCard } from "@/components/app/sip-status-card";
import { withUserTx, type Actor } from "@/lib/db/tx";
import { formatDate, formatINRCompact, humanize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { getSipItems } from "@/services/plans";
import { getClientSip, getSipProgress } from "@/services/sip";
import { getSipStatus } from "@/services/sip-status";
import type { ClientSummary, SipItem } from "@/types/domain";
import { setSipStatusAction } from "../actions";

const ACTION_TONE = { START: "bg-emerald-50 text-emerald-800", STOP: "bg-red-50 text-red-800", CHANGE: "bg-violet-50 text-violet-800" } as const;

/** What each SIP line looks like now. Done is set by the CAS (see reconciliation); advising is the only manual step. */
function status(s: SipItem): { label: string; tone: string } {
  if (s.status === "COMPLETED") {
    const fromCas = (s.notes ?? "").includes("Verified from CAS");
    const what = s.action === "STOP" ? "stopped" : s.action === "CHANGE" ? "changed" : "running";
    return { label: fromCas ? `Done · ${what} in CAS` : `Done · ${what}`, tone: "bg-emerald-50 text-emerald-800" };
  }
  if (s.status === "ADVISED") return { label: "Advised · not in CAS yet", tone: "bg-orange-50 text-orange-800" };
  if (s.status === "CANCELLED") return { label: "Cancelled", tone: "bg-slate-100 text-slate-500" };
  return { label: "Not advised yet", tone: "bg-slate-100 text-slate-700" };
}

function Kpi({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div>
      <div className="text-[10.5px] font-semibold uppercase tracking-wide text-muted">{label}</div>
      <div className={cn("text-xl font-semibold num", tone)}>{formatINRCompact(value)}<span className="text-xs font-normal text-muted">/mo</span></div>
    </div>
  );
}

/** The client's SIPs: one summary row, one table whose status comes from the CAS, and the instalments folded away. */
export async function SipTab({ client: c, actor }: { client: ClientSummary; actor: Actor }) {
  const d = await withUserTx(actor, async (tx) => ({
    sip: await getClientSip(tx, c.client_id),
    lines: c.active_plan_id ? await getSipItems(tx, c.active_plan_id) : [],
    progress: c.active_plan_id ? await getSipProgress(tx, c.active_plan_id) : [],
    seen: await getSipStatus(tx, c.client_id),
    recent: await tx<{ date: string; scheme_name: string; amount: number; units: number | null }[]>`
      select t.transaction_date::text as date, t.scheme_name, abs(t.amount)::float8 as amount, t.units::float8 as units
      from public.portfolio_transactions t
      where t.client_id = ${c.client_id} and public.txn_effective_type(t.transaction_type, t.description, t.units) = 'SIP' and coalesce(t.amount, 0) <> 0
      order by t.transaction_date desc limit 60`,
    lastCas: (await tx<{ d: string | null }[]>`
      select max(snapshot_date)::text as d from public.portfolio_snapshots where client_id = ${c.client_id} and review_status = 'CONFIRMED'`)[0]?.d ?? null,
  }));
  const invested = Object.fromEntries(d.progress.map((r) => [r.sip_item_id, r]));
  const canAdvise = actor.role !== "OPERATIONS" && Boolean(c.active_plan_id);
  const s = d.sip;
  const pct = s.sip_monthly_target > 0 ? Math.min(100, Math.round((s.sip_monthly_started / s.sip_monthly_target) * 100)) : 0;
  const lines = d.lines.filter((l) => l.status !== "CANCELLED");

  return (
    <div className="space-y-3">
      <section className="rounded-xl border border-border bg-surface px-4 py-3.5">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Kpi label="SIP target" value={s.sip_monthly_target} />
          <Kpi label="Advised" value={s.sip_monthly_advised} tone="text-blue-700" />
          <Kpi label="Running (CAS)" value={s.sip_monthly_started} tone="text-emerald-700" />
          <Kpi label="Left to advise" value={s.sip_monthly_yet_to_advise} />
        </div>
        <div className="mt-3 h-1.5 rounded-full bg-slate-100"><div className="h-1.5 rounded-full bg-emerald-500" style={{ width: `${pct}%` }} /></div>
      </section>

      <section className="overflow-hidden rounded-xl border border-border bg-surface">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
          <h3 className="text-sm font-semibold">SIPs in the plan · {lines.length}</h3>
          <div className="flex flex-wrap items-center gap-3">
            {canAdvise && lines.some((l) => l.status === "PLANNED" || l.status === "ADVISED") ? (
              <ActionForm action={recheckSipAction.bind(null, c.client_id)} className="flex items-center gap-2">
                <SubmitButton size="sm" variant="outline">Re-check from CAS</SubmitButton>
              </ActionForm>
            ) : null}
            {c.active_plan_id ? <Link className="text-xs text-brand hover:underline" href={`/clients/${c.client_id}/plans/${c.active_plan_id}`}>Change amounts / move lump sum ↔ SIP</Link> : null}
          </div>
        </div>
        {lines.length === 0 ? <p className="px-4 py-3 text-sm text-muted">{c.active_plan_id ? "The active plan has no SIP lines." : "No active plan."}</p> : (
          <Table className="text-[13px]">
            <THead><TR><TH>Action</TH><TH>Fund</TH><TH>Amount</TH><TH className="text-right">Invested so far</TH><TH>Status (from CAS)</TH>{canAdvise ? <TH /> : null}</TR></THead>
            <TBody>
              {lines.map((l) => {
                const st = status(l);
                const inv = invested[l.id];
                return (
                  <TR key={l.id}>
                    <TD><span className={cn("rounded-full px-2 py-0.5 text-[11px] font-bold", ACTION_TONE[l.action])}>{l.action}</span></TD>
                    <TD className="max-w-80"><div className="truncate font-medium" title={l.scheme_name}>{l.scheme_name}</div></TD>
                    <TD className="whitespace-nowrap num">
                      {l.action === "STOP" ? <><Money value={l.old_amount} full /> → stop</>
                        : l.action === "CHANGE" ? <><Money value={l.old_amount} full /> → <Money value={l.new_amount} full /></>
                        : <><Money value={l.new_amount} full /> / {l.frequency === "MONTHLY" ? "mo" : humanize(l.frequency).toLowerCase()}</>}
                    </TD>
                    <TD className="text-right num">{l.action === "STOP" ? <span className="text-muted">—</span> : <Money value={inv?.invested_amount ?? 0} full />}</TD>
                    <TD>
                      <span className={cn("rounded-full px-2 py-0.5 text-[11.5px] font-semibold", st.tone)}>{st.label}</span>
                      {l.status === "COMPLETED" && l.completed_at ? <span className="ml-1.5 text-[11px] text-muted">{formatDate(l.completed_at)}</span> : null}
                      {(() => {
                        // What the latest CAS shows for this fund, whatever the line's status.
                        const seen = d.seen.plan.find((p) => p.id === l.id);
                        // Without the fund's ISIN the CAS cannot be matched to this line: say nothing.
                        if (!d.seen.latestCasDate || !seen?.isin) return null;
                        const now = seen.now;
                        const text = !now || now.state === "NONE" ? "No SIP in this fund in the CAS"
                          : now.state === "ACTIVE" ? `CAS: ₹${(now.amount ?? 0).toLocaleString("en-IN")}/mo running, last ${formatDate(now.lastInstalment)}${l.action !== "STOP" && l.new_amount && Math.abs((now.amount ?? 0) - Number(l.new_amount)) > Math.max(50, Number(l.new_amount) * 0.01) ? ` · plan ₹${Number(l.new_amount).toLocaleString("en-IN")}` : ""}`
                          : `CAS: no SIP running${now.lastInstalment ? `, last ${formatDate(now.lastInstalment)}` : ""}`;
                        return <div className="mt-1 text-[11px] text-muted">{text}</div>;
                      })()}
                    </TD>
                    {canAdvise ? (
                      <TD className="text-right">
                        {l.status === "PLANNED" ? (
                          <ActionForm action={setSipStatusAction.bind(null, c.client_id, l.id)}>
                            <input type="hidden" name="status" value="ADVISED" />
                            <SubmitButton size="sm" variant="outline">Mark advised</SubmitButton>
                          </ActionForm>
                        ) : null}
                      </TD>
                    ) : null}
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </section>

      <details className="rounded-xl border border-border bg-surface">
        <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-semibold">SIPs seen in CAS · every instalment{d.recent.length ? ` · ${d.recent.length}` : ""}</summary>
        {d.seen.latestCasDate ? <div className="border-t border-border p-3"><SipStatusCard sip={d.seen} /></div> : null}
        {d.recent.length ? (
          <div className="max-h-96 overflow-y-auto border-t border-border">
            <Table className="text-[13px]">
              <THead><TR><TH>Date</TH><TH>Fund</TH><TH className="text-right">Amount</TH><TH className="text-right">Units</TH></TR></THead>
              <TBody>
                {d.recent.map((r, i) => (
                  <TR key={`${r.date}-${i}`}>
                    <TD className="whitespace-nowrap text-xs">{formatDate(r.date)}</TD>
                    <TD className="max-w-80"><div className="truncate text-xs" title={r.scheme_name}>{r.scheme_name}</div></TD>
                    <TD className="text-right"><Money value={r.amount} full /></TD>
                    <TD className="text-right num text-xs">{r.units?.toFixed(3) ?? "—"}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        ) : <p className="border-t border-border px-4 py-3 text-sm text-muted">None yet.{d.lastCas ? ` Latest CAS ${formatDate(d.lastCas)}; the next CAS will show what changed.` : ""}</p>}
      </details>
      <p className="text-xs text-muted">Status updates by itself from each new CAS. Advising a SIP is the only step done by hand.</p>
    </div>
  );
}
