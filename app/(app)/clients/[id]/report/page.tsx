import Link from "next/link";
import { Field, Textarea } from "@/components/ui/form";
import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { formatDate, formatDateTime, formatINR, formatINRCompact, humanize } from "@/lib/format";
import { pageData } from "@/lib/server";
import { cn } from "@/lib/utils";
import { getClientSummary } from "@/services/clients";
import { getPremium, getReportNotes } from "@/services/client-record";
import { getMonthlyReport } from "@/services/monthly-report";
import { getClientSip } from "@/services/sip";
import { saveReportNotesAction } from "../record-actions";
import { PrintButton } from "./print-button";

export const metadata = { title: "Monthly client report" };

const INK = "text-[#0d3443]";

function Section({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("break-inside-avoid rounded-xl border border-slate-200 bg-white p-4", className)}>
      <h2 className={cn("mb-3 flex items-center gap-2 text-[13px] font-bold uppercase tracking-[0.12em]", INK)}>
        <span className="inline-block h-4 w-1 rounded bg-amber-400" aria-hidden />{title}
      </h2>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-slate-100 py-1.5 text-[13px] last:border-0">
      <span className="text-slate-600">{label}</span><span className="text-right font-semibold text-slate-900">{value}</span>
    </div>
  );
}

function Bar({ label, value, pct, color }: { label: string; value: string; pct: number; color: string }) {
  return (
    <div className="mb-2">
      <div className="flex justify-between text-[13px]"><span>{label}</span><span className="font-semibold">{value}</span></div>
      <div className="mt-1 h-2 rounded-full bg-slate-100"><div className={cn("h-2 rounded-full", color)} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} /></div>
    </div>
  );
}

const shiftMonth = (ym: string, d: number) => {
  const [y, m] = ym.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + d, 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}`;
};

export default async function MonthlyReportPage(props: PageProps<"/clients/[id]/report">) {
  const { id } = await props.params;
  const sp = await props.searchParams;
  const thisMonth = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit" }).format(new Date());
  const ym = typeof sp.month === "string" && /^\d{4}-\d{2}$/.test(sp.month) ? sp.month : thisMonth;
  const { c, r, notes, premium, sip, actor } = await pageData(async (tx) => ({
    c: await getClientSummary(tx, id),
    r: await getMonthlyReport(tx, id, ym),
    notes: await getReportNotes(tx, id, `${ym}-01`),
    premium: await getPremium(tx, id),
    sip: await getClientSip(tx, id),
  }));
  const canEdit = actor.role !== "OPERATIONS";
  const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);
  const change = r.startValue && r.endValue ? r.endValue.value - r.startValue.value : null;
  const actions = (notes.actions ?? "").split(/\n+/).map((x) => x.trim()).filter(Boolean).slice(0, 6);

  // Key takeaways, from the numbers (the advisor's own words go in the outlook below).
  const takeaways: React.ReactNode[] = [];
  if (r.endValue) {
    takeaways.push(<>Portfolio at <b>{formatINRCompact(r.endValue.value)}</b>{change !== null ? <> ({change >= 0 ? "+" : "−"}{formatINRCompact(Math.abs(change))} over the month)</> : null}, per the CAS of {formatDate(r.endValue.date)}.</>);
  }
  takeaways.push(r.totals.callCount
    ? <><b>{r.totals.callCount} call(s)</b> advised this month: sell <b>{formatINRCompact(r.totals.advisedSell)}</b>, buy <b>{formatINRCompact(r.totals.advisedBuy)}</b>.</>
    : <>No new calls this month.</>);
  takeaways.push(<><b>{formatINRCompact(r.totals.executed)}</b> executed this month ({formatINRCompact(r.totals.executedSell)} sold, {formatINRCompact(r.totals.executedBuy)} bought).</>);
  if (c.target_sell + c.target_buy > 0) {
    takeaways.push(<>Rebalancing <b>{pct(c.executed_sell + c.executed_buy, c.target_sell + c.target_buy)}% done</b> overall: {formatINRCompact(c.pending_total)} advised and awaiting execution, {formatINRCompact(c.yet_to_advise_sell + c.yet_to_advise_buy)} still to advise.</>);
  }
  if (r.sip.instalments) takeaways.push(<><b>{formatINRCompact(r.sip.amount)}</b> invested through {r.sip.instalments} SIP instalment(s).</>);
  if (r.unadvised.length) takeaways.push(<><b>{r.unadvised.length} trade(s)</b> made without a call ({formatINRCompact(r.unadvised.reduce((t, u) => t + u.amount, 0))}).</>);

  return (
    <div className="mx-auto max-w-5xl print:max-w-none">
      {/* Toolbar (not printed) */}
      <div className="mb-3 flex flex-wrap items-center gap-2 print:hidden">
        <Link href={`/clients/${id}?tab=reports`} className="text-xs text-muted hover:underline">← {c.full_name}</Link>
        <div className="ml-auto flex items-center gap-1 text-sm">
          <Link className="rounded-md px-2 py-1 ring-1 ring-border hover:bg-slate-50" href={`/clients/${id}/report?month=${shiftMonth(ym, -1)}`}>‹ Previous</Link>
          <span className="px-2 font-medium">{r.label}</span>
          {ym < thisMonth ? <Link className="rounded-md px-2 py-1 ring-1 ring-border hover:bg-slate-50" href={`/clients/${id}/report?month=${shiftMonth(ym, 1)}`}>Next ›</Link> : null}
          <PrintButton />
        </div>
      </div>

      <article className="space-y-3 bg-[#f7f9fb] p-1 text-slate-800 print:bg-white">
        <header className="border-t-4 border-[#0d3443] pt-3">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h1 className={cn("text-3xl font-extrabold tracking-tight", INK)}>{c.full_name}</h1>
              <p className="text-sm text-slate-600">Monthly portfolio report · <b>{r.label}</b></p>
            </div>
            <div className="text-right text-xs text-slate-600">
              <div>Client ID <b className="font-mono">{c.client_code}</b></div>
              <div>Advisor <b>{c.advisor_name ?? "—"}</b> · Risk <b>{humanize(c.risk_profile)}</b></div>
              <div>Prepared {formatDate(new Date())}</div>
            </div>
          </div>
        </header>

        <section className="break-inside-avoid rounded-xl bg-[#0d3443] p-5 text-white">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-[0.18em] text-amber-300">★ Key takeaways</h2>
          <ol className="grid gap-x-6 gap-y-2.5 md:grid-cols-2">
            {[...(notes.summary ? [<>{notes.summary}</>] : []), ...takeaways].slice(0, 6).map((t, i) => (
              <li key={i} className="flex gap-2.5 text-[14px] leading-snug">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-400 text-[11px] font-bold text-[#0d3443]">{i + 1}</span>
                <span>{t}</span>
              </li>
            ))}
          </ol>
        </section>

        <div className="grid gap-3 md:grid-cols-2">
          <Section title="Portfolio snapshot">
            <Row label="Value at start of month" value={r.startValue ? `${formatINR(r.startValue.value)} · ${formatDate(r.startValue.date)}` : "—"} />
            <Row label="Value at end of month" value={r.endValue ? `${formatINR(r.endValue.value)} · ${formatDate(r.endValue.date)}` : "—"} />
            <Row label="Change over the month" value={change === null ? "—" : <span className={change >= 0 ? "text-emerald-700" : "text-red-700"}>{change >= 0 ? "+" : "−"}{formatINR(Math.abs(change))}</span>} />
            <Row label="Value today (latest NAV)" value={formatINR(c.live_portfolio_value ?? 0)} />
            <Row label="Value at onboarding" value={formatINR(c.initial_portfolio_value ?? 0)} />
            <Row label="Invested under the plan" value={formatINR(sip.total_invested_under_plan)} />
            <Row label="MF Premium" value={premium.paid_until ? `Paid till ${formatDate(premium.paid_until)}` : humanize(premium.premium_status)} />
          </Section>

          <Section title="How the money is split">
            {r.categories.length ? r.categories.map((x, i) => (
              <Bar key={x.category} label={x.category} value={`${(x.weight * 100).toFixed(1)}% · ${formatINRCompact(x.value)}`} pct={x.weight * 100}
                color={["bg-[#0d3443]", "bg-[#1f6f84]", "bg-[#5aa1b3]", "bg-[#9cc8d3]", "bg-slate-300"][i % 5]} />
            )) : <p className="text-sm text-slate-500">No CAS on record for this month.</p>}
            {r.holdings.length ? (
              <div className="mt-3 border-t border-slate-100 pt-2">
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Largest holdings</div>
                {r.holdings.slice(0, 6).map((h) => (
                  <div key={h.scheme_name} className="flex justify-between gap-3 text-[12px]"><span className="truncate">{h.scheme_name}</span><span className="shrink-0 font-medium">{(h.weight * 100).toFixed(1)}%</span></div>
                ))}
              </div>
            ) : null}
          </Section>
        </div>

        <Section title="Rebalancing progress (plan to date)">
          {c.target_sell + c.target_buy > 0 ? (
            <div className="grid gap-4 md:grid-cols-2">
              {([["Exit (sell)", c.target_sell, c.advised_sell, c.executed_sell, c.pending_sell], ["Deploy (buy)", c.target_buy, c.advised_buy, c.executed_buy, c.pending_buy]] as const).map(([l, t, a, e, p]) => (
                <div key={l}>
                  <div className="mb-1 flex justify-between text-[13px] font-semibold"><span>{l}</span><span>{pct(e, t)}% executed</span></div>
                  <Bar label="Planned" value={formatINRCompact(t)} pct={100} color="bg-slate-300" />
                  <Bar label="Advised" value={formatINRCompact(a)} pct={pct(a, t)} color="bg-blue-600" />
                  <Bar label="Executed" value={formatINRCompact(e)} pct={pct(e, t)} color="bg-emerald-600" />
                  <Bar label="Awaiting execution" value={formatINRCompact(p)} pct={pct(p, t)} color="bg-amber-400" />
                </div>
              ))}
            </div>
          ) : <p className="text-sm text-slate-500">No active rebalancing plan.</p>}
        </Section>

        <Section title={`Calls advised in ${r.label}`}>
          {r.calls.length ? (
            <table className="w-full text-[12.5px] [&_td]:px-1.5 [&_th]:px-1.5">
              <thead className="text-left text-[11px] uppercase tracking-wide text-slate-500"><tr><th className="py-1">Date</th><th>Action</th><th>Fund</th><th className="text-right">Advised</th><th className="text-right">Executed</th><th>Status</th></tr></thead>
              <tbody>
                {r.calls.map((x) => (
                  <tr key={x.id} className="border-t border-slate-100 align-top">
                    <td className="whitespace-nowrap py-1">{formatDate(x.at)}</td>
                    <td className={cn("font-semibold", x.action === "BUY" ? "text-emerald-700" : "text-red-700")}>{x.action}</td>
                    <td className="max-w-[18rem] truncate">{x.scheme_name}{x.on_plan ? "" : <span className="text-slate-400"> · off-plan</span>}</td>
                    <td className="text-right">{formatINR(x.advised_amount)}</td>
                    <td className="text-right">{formatINR(x.executed_amount)}</td>
                    <td>{humanize(x.status)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr className="border-t border-slate-300 font-semibold"><td colSpan={3} className="py-1">Total</td><td className="text-right">{formatINR(r.totals.advised)}</td><td className="text-right">{formatINR(r.calls.reduce((t, x) => t + x.executed_amount, 0))}</td><td /></tr></tfoot>
            </table>
          ) : <p className="text-sm text-slate-500">No calls were advised this month.</p>}
        </Section>

        <div className="grid gap-3 md:grid-cols-2">
          <Section title={`Executed in ${r.label}`}>
            {r.executions.length ? r.executions.map((e, i) => (
              <div key={i} className="flex justify-between gap-3 border-b border-slate-100 py-1 text-[12.5px] last:border-0">
                <span className="truncate"><span className="text-slate-500">{formatDate(e.date)}</span> · <b className={e.action === "BUY" ? "text-emerald-700" : "text-red-700"}>{e.action}</b> {e.scheme_name}</span>
                <span className="shrink-0 font-medium">{formatINR(e.amount)}</span>
              </div>
            )) : <p className="text-sm text-slate-500">Nothing executed this month.</p>}
          </Section>
          <Section title="SIPs">
            <Row label="Invested via SIP this month" value={`${formatINR(r.sip.amount)} · ${r.sip.instalments} instalment(s)`} />
            <Row label="SIP plan (monthly)" value={`${formatINRCompact(sip.sip_monthly_target)} planned · ${formatINRCompact(sip.sip_monthly_started)} running`} />
            <Row label="SIP invested since advised" value={formatINR(sip.sip_invested)} />
            {r.sip.byFund.slice(0, 5).map((f) => (
              <div key={f.scheme_name} className="flex justify-between gap-3 text-[12px] text-slate-600"><span className="truncate">{f.scheme_name}</span><span>{formatINR(f.amount)}</span></div>
            ))}
          </Section>
        </div>

        {r.unadvised.length ? (
          <Section title="Trades without our advice">
            {r.unadvised.map((u, i) => (
              <div key={i} className="flex justify-between gap-3 border-b border-slate-100 py-1 text-[12.5px] last:border-0">
                <span className="truncate"><span className="text-slate-500">{u.date ? formatDate(u.date) : "—"}</span> · {u.direction} · {u.scheme_name}</span>
                <span className="shrink-0">{formatINR(u.amount)} <span className="text-slate-500">· {u.review}</span></span>
              </div>
            ))}
          </Section>
        ) : null}

        <Section title="Our advisory view & outlook">
          {notes.outlook ? (
            <div className="rounded-lg border-l-4 border-amber-400 bg-amber-50 p-3 text-[14px] leading-relaxed text-[#7a2e0e] whitespace-pre-wrap">{notes.outlook}</div>
          ) : <p className="text-sm text-slate-500">{canEdit ? "Add your view for this month below." : "No outlook recorded for this month."}</p>}
        </Section>

        {actions.length ? (
          <section className="break-inside-avoid">
            <h2 className={cn("mb-2 flex items-center gap-2 text-[13px] font-bold uppercase tracking-[0.12em]", INK)}><span className="inline-block h-4 w-1 rounded bg-amber-400" aria-hidden />Recommended actions</h2>
            <div className="grid gap-3 md:grid-cols-3">
              {actions.map((a, i) => {
                const [head, ...rest] = a.split(/\s[-–:]\s/);
                return (
                  <div key={i} className="rounded-xl border border-slate-200 bg-white p-3">
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#0d3443] text-xs font-bold text-white">{i + 1}</span>
                    <div className="mt-2 text-[14px] font-bold text-[#0d3443]">{head}</div>
                    {rest.length ? <p className="text-[13px] text-slate-600">{rest.join(" – ")}</p> : null}
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

        <footer className="border-t border-slate-300 pt-2 text-[10.5px] leading-snug text-slate-500">
          <b>Disclaimer:</b> For information and discussion only. Figures are from the client&apos;s CAS statements, the latest available NAVs and calls recorded on the advisory desk, and may change.
          Mutual fund investments are subject to market risks; read all scheme-related documents carefully. Report for {c.full_name} ({c.client_code}), {r.label}.
        </footer>
      </article>

      {canEdit ? (
        <section className="mt-4 rounded-xl border border-border bg-white p-4 print:hidden">
          <h2 className="mb-1 text-sm font-semibold">Your words for {r.label}</h2>
          <p className="mb-3 text-xs text-muted">
            Saved with the client record{notes.updated_at ? ` (last saved ${formatDateTime(notes.updated_at)})` : ""}. Recommended actions: one per line, e.g. &quot;Hold &amp; watch – no action needed right now&quot;.
          </p>
          <ActionForm action={saveReportNotesAction.bind(null, id, `${ym}-01`)} className="grid gap-3 md:grid-cols-3">
            <Field label="Headline takeaway (shown first)"><Textarea name="summary" rows={4} defaultValue={notes.summary ?? ""} /></Field>
            <Field label="Advisory view & outlook"><Textarea name="outlook" rows={4} defaultValue={notes.outlook ?? ""} /></Field>
            <Field label="Recommended actions (one per line)"><Textarea name="actions" rows={4} defaultValue={notes.actions ?? ""} /></Field>
            <div className="md:col-span-3"><SubmitButton size="sm">Save report notes</SubmitButton></div>
          </ActionForm>
        </section>
      ) : null}
    </div>
  );
}
