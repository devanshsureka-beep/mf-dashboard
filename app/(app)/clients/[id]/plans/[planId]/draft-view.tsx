import Link from "next/link";
import { Field, Input, Select } from "@/components/ui/form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { Money } from "@/components/app/money";
import { ActionBadge } from "@/components/app/status-badge";
import { SecuritySelect } from "@/components/app/security-select";
import { SipTable } from "@/components/app/sip-table";
import { formatDate, formatINRCompact, humanize } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ClientSummary, PlanItemProgress, PlanRow, PlanTransition, SipItem } from "@/types/domain";
import type { ReportQuestionRow } from "@/services/plans";
import type { listAllSecurities } from "@/services/securities";
import { ReportQuestions } from "./questions";
import { ItemEditor } from "./item-editor";
import { AsReportedNote } from "./as-reported-note";
import {
  addPlanItemAction, addSipAction, approvePlanAction, closePlanAction, convertMigrateNotesAction, deleteSipAction,
  resolveSipSecurityAction, updateSipAmountsAction, convertSipToLumpsumAction,
} from "../actions";

const STEPS = ["Onboarded", "Review draft", "Approve", "Give calls", "CAS check"];

/** Where the client is: onboarded → review → approve → calls → CAS check. */
export function JourneySteps({ current }: { current: number }) {
  return (
    <ol aria-label="Client journey" className="mt-3 flex flex-wrap gap-1.5 text-xs">
      {STEPS.map((s, i) => (
        <li key={s} aria-current={i === current ? "step" : undefined}
          className={cn("rounded-full px-3 py-1 font-medium", i < current ? "bg-emerald-50 text-emerald-800" : i === current ? "bg-brand text-white" : "bg-slate-100 text-slate-500")}>
          {i < current ? "✓" : `${i + 1} ·`} {s}
        </li>
      ))}
    </ol>
  );
}

/** A folded group of plan lines (Sell / Buy / SIP / Keep) with its total on the summary row. */
function Group({ title, count, total, tone, open, attention, children }: {
  title: string; count: React.ReactNode; total: React.ReactNode; tone: string; open?: boolean; attention?: string | null; children: React.ReactNode;
}) {
  return (
    <details open={open} className="group overflow-visible rounded-xl border border-border bg-surface">
      <summary className="flex cursor-pointer select-none list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <span className="text-muted transition-transform group-open:rotate-90">▸</span>
        <span className={cn("font-semibold", tone)}>{title}</span>
        <span className="text-sm text-muted">· {count}</span>
        {attention ? <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-900">{attention}</span> : null}
        <span className="ml-auto text-sm font-semibold">{total}</span>
      </summary>
      <div className="border-t border-border">{children}</div>
    </details>
  );
}

function Check({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return <li className={cn("flex gap-2", ok ? "text-emerald-800" : "font-medium text-amber-900")}><span aria-hidden>{ok ? "✓" : "•"}</span><span>{children}</span></li>;
}

type Securities = Awaited<ReturnType<typeof listAllSecurities>>;

export function DraftView({ c, plan, items, sips, questions, securities, heldIds, migrateNotes, canAdvise, clientId, planId, onboarded }: {
  c: ClientSummary;
  plan: PlanRow & PlanTransition;
  items: PlanItemProgress[];
  sips: SipItem[];
  questions: ReportQuestionRow[];
  securities: Securities;
  heldIds: string[];
  migrateNotes: number;
  canAdvise: boolean;
  clientId: string;
  planId: string;
  onboarded: string | null;
}) {
  const live = items.filter((i) => i.item_status !== "CANCELLED");
  const sells = live.filter((i) => i.side === "SELL");
  const buys = live.filter((i) => i.side === "BUY");
  const keeps = live.filter((i) => i.side === "NONE");
  const liveSips = sips.filter((s) => s.status !== "CANCELLED");
  const sum = (xs: PlanItemProgress[], f: (i: PlanItemProgress) => number | null) => xs.reduce((t, i) => t + (f(i) ?? 0), 0);
  const flagged = (xs: PlanItemProgress[]) => xs.filter((i) => i.needs_review || (i.side !== "NONE" && !i.security_id)).length;
  const openQ = questions.filter((q) => q.open).length;
  const missingSecurity = live.filter((i) => i.side !== "NONE" && !i.security_id).length;
  const reviewLines = live.filter((i) => i.needs_review).length + liveSips.filter((s) => s.needs_review).length;
  const blockers = openQ + missingSecurity + reviewLines;
  const sipStarts = liveSips.filter((s) => s.action === "START").length;
  const sipStops = liveSips.filter((s) => s.action === "STOP").length;
  const sipChanges = liveSips.filter((s) => s.action === "CHANGE").length;
  const sipMonthly = liveSips.reduce((t, s) => t + (s.action === "STOP" ? 0 : Number(s.new_amount ?? 0)), 0);
  const additional = plan.plan_kind === "ADDITIONAL" && Boolean(c.active_plan_id);
  const replacing = Boolean(c.active_plan_id && c.active_plan_id !== planId && plan.plan_kind !== "ADDITIONAL");
  const editor = (i: PlanItemProgress) => canAdvise ? <ItemEditor i={i} clientId={clientId} planId={planId} isActive={false} securities={securities} heldIds={heldIds} label="Edit" alignRight /> : null;

  const lineTable = (rows: PlanItemProgress[], amountLabel: string, amount: (i: PlanItemProgress) => number | null) => (
    <div className="overflow-x-auto lg:overflow-visible">
      <table className="w-full text-[13px]">
        <thead className="bg-slate-50 text-left text-[10.5px] font-semibold uppercase tracking-wide text-muted">
          <tr><th className="px-4 py-2">Fund</th><th className="px-2 py-2">Report says</th><th className="px-2 py-2 text-right">Holding</th><th className="px-2 py-2 text-right">{amountLabel}</th><th className="w-16 px-4 py-2" /></tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((i) => (
            <tr key={i.plan_item_id} className="align-top">
              <td className="max-w-80 px-4 py-2">
                <div className="truncate font-medium" title={i.scheme_name}>{i.scheme_name}</div>
                <div className="flex flex-wrap gap-1">
                  {i.folio_number ? <span className="text-[11px] text-muted">folio {i.folio_number}</span> : null}
                  {i.action === "SWITCH" ? <ActionBadge action="SWITCH" /> : null}
                  {i.needs_review ? <Badge tone="pending">check this line</Badge> : null}
                  {i.side !== "NONE" && !i.security_id ? <Badge tone="danger">pick the fund</Badge> : null}
                </div>
              </td>
              <td className="max-w-72 px-2 py-2 text-xs text-slate-700"><div className="line-clamp-2" title={i.reason ?? ""}>{i.reason?.replace(/^Report: /, "") || "—"}</div></td>
              <td className="whitespace-nowrap px-2 py-2 text-right"><Money value={i.current_amount} /></td>
              <td className="whitespace-nowrap px-2 py-2 text-right font-semibold"><Money value={amount(i)} /></td>
              <td className="whitespace-nowrap px-4 py-2 text-right">{editor(i)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      <div className="mb-4">
        <div className="text-xs text-muted">
          <Link href="/clients" className="hover:underline">Clients</Link> / <Link href={`/clients/${clientId}`} className="hover:underline">{c.full_name}</Link> / <Link href="/clients?plan=draft" className="hover:underline">Drafts</Link>
        </div>
        <h1 className="mt-0.5 flex flex-wrap items-center gap-2 text-xl font-semibold">
          {c.full_name} <Badge tone="pending">DRAFT</Badge>
          {plan.plan_kind === "ADDITIONAL" ? <Badge tone="info">Additional money</Badge> : replacing ? <Badge tone="info">New full plan</Badge> : null}
        </h1>
        <div className="mt-1 text-sm text-muted">
          Report of {formatDate(plan.plan_date)}{c.latest_cas_date ? ` · CAS of ${formatDate(c.latest_cas_date)}` : ""} · <Money value={plan.starting_portfolio_value} /> at the report
          {plan.fresh_money ? <> · fresh money <Money value={plan.fresh_money} /></> : null}
        </div>
        <JourneySteps current={1} />
      </div>

      {onboarded ? (
        <p className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-900">
          {onboarded === "new" ? "Client created and" : "Documents read and"} this draft made from the report. Answer what is open on the left, then approve on the right.
        </p>
      ) : null}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-3">
          {plan.as_reported ? <AsReportedNote a={plan.as_reported} /> : null}
          {additional ? (
            <div className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
              Approving adds these lines to the <Link className="underline" href={`/clients/${clientId}/plans/${c.active_plan_id}`}>active plan</Link> as a new tranche{plan.fresh_money ? <> with <Money value={plan.fresh_money} /> of fresh money</> : null}. The current plan, its calls and its numbers stay.
            </div>
          ) : null}

          {questions.length ? (
            <ReportQuestions rows={questions} clientId={clientId} planId={planId} canAnswer={canAdvise} foldAnswered
              title={openQ ? `Before you approve · ${openQ} of ${questions.length} left` : `Before you approve · all ${questions.length} answered`} />
          ) : null}

          {migrateNotes > 0 && canAdvise ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-sky-200 bg-white px-4 py-3 text-sm">
              <span><strong>{migrateNotes}</strong> Regular fund(s) say &ldquo;Migrate to Direct&rdquo; only as a note on a Keep line.</span>
              <ActionForm action={convertMigrateNotesAction.bind(null, clientId, planId)}>
                <SubmitButton size="sm">Turn them into Sell (Regular) + Buy (Direct)</SubmitButton>
              </ActionForm>
            </div>
          ) : null}

          <Group title="Sell" tone="text-red-700" count={`${sells.length} fund${sells.length === 1 ? "" : "s"}`} total={<Money value={sum(sells, (i) => i.original_target_amount)} />}
            open={flagged(sells) > 0} attention={flagged(sells) ? `${flagged(sells)} to check` : null}>
            {sells.length ? lineTable(sells, "Sell", (i) => i.original_target_amount) : <p className="px-4 py-3 text-sm text-muted">Nothing to sell.</p>}
          </Group>

          <Group title="Buy" tone="text-blue-700" count={`${buys.length} fund${buys.length === 1 ? "" : "s"}`} total={<Money value={sum(buys, (i) => i.original_target_amount)} />}
            open={flagged(buys) > 0} attention={flagged(buys) ? `${flagged(buys)} to check` : null}>
            {buys.length ? lineTable(buys, "Buy", (i) => i.original_target_amount) : <p className="px-4 py-3 text-sm text-muted">Nothing to buy.</p>}
          </Group>

          <Group title="SIP" tone="text-violet-700"
            count={[sipStarts ? `${sipStarts} start` : null, sipChanges ? `${sipChanges} change` : null, sipStops ? `${sipStops} stop` : null].filter(Boolean).join(", ") || "no SIP lines"}
            total={<><Money value={sipMonthly} full /> / month</>}
            open={liveSips.some((s) => s.needs_review)} attention={liveSips.filter((s) => s.needs_review).length ? `${liveSips.filter((s) => s.needs_review).length} to check` : null}>
            {sips.length ? (
              <SipTable
                rows={sips}
                canUpdate={false}
                extra={canAdvise ? (s) => s.status === "CANCELLED" ? null : (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-brand">⋯ Edit</summary>
                    <div className="mt-2 space-y-2">
                      <ActionForm action={updateSipAmountsAction.bind(null, clientId, planId, s.id)} className="flex flex-wrap items-end gap-1">
                        {s.action !== "START" ? <Field label="Old ₹"><Input name="old_amount" className="h-8 w-24 text-xs" defaultValue={s.old_amount ?? ""} /></Field> : null}
                        {s.action !== "STOP" ? <Field label="New ₹/instalment"><Input name="new_amount" className="h-8 w-28 text-xs" defaultValue={s.new_amount ?? ""} /></Field> : null}
                        <Field label="Day"><Input name="debit_day" className="h-8 w-14 text-xs" defaultValue={s.debit_day ?? ""} /></Field>
                        <Field label="Reason *"><Input name="reason" className="h-8 w-40 text-xs" required /></Field>
                        <SubmitButton size="sm" variant="outline">Save</SubmitButton>
                      </ActionForm>
                      {s.needs_review ? (
                        <ActionForm action={resolveSipSecurityAction.bind(null, clientId, planId, s.id)} className="flex flex-wrap items-end gap-1">
                          <SecuritySelect securities={securities} heldIds={heldIds} className="w-80" required />
                          <SubmitButton size="sm" variant="outline">Confirm fund</SubmitButton>
                        </ActionForm>
                      ) : null}
                      {s.action !== "STOP" && s.security_id ? (
                        <ActionForm action={convertSipToLumpsumAction.bind(null, clientId, planId, s.id)} className="flex flex-wrap items-end gap-1">
                          <Field label="Lump sum ₹ *"><Input name="lumpsum_amount" className="h-8 w-28 text-xs" required /></Field>
                          <Field label="Reason *"><Input name="reason" className="h-8 w-40 text-xs" required /></Field>
                          <SubmitButton size="sm" variant="outline" confirm="Cancel this SIP line and add a lump-sum buy instead?">Make lump sum</SubmitButton>
                        </ActionForm>
                      ) : null}
                      <ActionForm action={deleteSipAction.bind(null, clientId, planId, s.id)}>
                        <SubmitButton size="sm" variant="ghost" confirm="Remove this SIP line from the draft?">Remove from draft</SubmitButton>
                      </ActionForm>
                    </div>
                  </details>
                ) : undefined}
              />
            ) : <p className="px-4 py-3 text-sm text-muted">No SIP to start, change or stop.</p>}
          </Group>

          <Group title="Keep" tone="text-slate-700" count={`${keeps.length} fund${keeps.length === 1 ? "" : "s"}`} total={<><Money value={sum(keeps, (i) => i.current_amount)} /> held</>}
            open={flagged(keeps) > 0} attention={flagged(keeps) ? `${flagged(keeps)} to check` : null}>
            {keeps.length ? lineTable(keeps, "Moves", () => null) : <p className="px-4 py-3 text-sm text-muted">No fund kept as it is.</p>}
          </Group>

          {canAdvise ? (
            <details className="rounded-xl border border-dashed border-border bg-white">
              <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-medium text-brand">+ Add a line the report missed</summary>
              <div className="space-y-4 border-t border-border px-4 py-3">
                <ActionForm action={addPlanItemAction.bind(null, clientId, planId)} className="grid gap-3 md:grid-cols-6" resetOnSuccess>
                  <Field label="Fund" className="md:col-span-2"><SecuritySelect securities={securities} heldIds={heldIds} required /></Field>
                  <Field label="Action">
                    <Select name="action" defaultValue="BUY"><option>BUY</option><option>SELL</option><option value="RETAIN">KEEP</option></Select>
                  </Field>
                  <Field label="Amount (₹)"><Input name="target_amount" inputMode="decimal" placeholder="e.g. 500000" /></Field>
                  <Field label="Holding (₹)"><Input name="current_amount" inputMode="decimal" /></Field>
                  <Field label="Target weight %"><Input name="target_weight" inputMode="decimal" /></Field>
                  <Field label="Reason" className="md:col-span-5"><Input name="reason" /></Field>
                  <div className="self-end"><SubmitButton size="sm">Add line</SubmitButton></div>
                </ActionForm>
                <ActionForm action={addSipAction.bind(null, clientId, planId)} className="grid gap-3 border-t border-border pt-3 md:grid-cols-7" resetOnSuccess>
                  <Field label="SIP fund" className="md:col-span-2"><SecuritySelect securities={securities} heldIds={heldIds} required /></Field>
                  <Field label="Action"><Select name="action"><option>START</option><option>STOP</option><option>CHANGE</option></Select></Field>
                  <Field label="Old ₹/instalment"><Input name="old_amount" inputMode="decimal" /></Field>
                  <Field label="New ₹/instalment"><Input name="new_amount" inputMode="decimal" /></Field>
                  <Field label="Frequency"><Select name="frequency" defaultValue="MONTHLY"><option>MONTHLY</option><option>WEEKLY</option><option>DAILY</option><option>QUARTERLY</option></Select></Field>
                  <Field label="Debit day"><Input name="debit_day" inputMode="numeric" /></Field>
                  <div className="md:col-span-7"><SubmitButton size="sm" variant="outline">Add SIP line</SubmitButton></div>
                </ActionForm>
              </div>
            </details>
          ) : null}
        </div>

        <aside aria-label="Approve" className="space-y-3 lg:sticky lg:top-4">
          <section className="rounded-xl border border-brand/30 bg-surface p-4">
            <h2 className="font-semibold">Ready to approve?</h2>
            <ul className="mt-2 space-y-1.5 text-sm">
              <Check ok={openQ === 0}>{openQ ? <a className="underline" href="#questions">{openQ} question{openQ === 1 ? "" : "s"} to answer</a> : "Report questions answered"}</Check>
              <Check ok={missingSecurity === 0}>{missingSecurity ? `${missingSecurity} line(s) without a fund picked` : "Funds picked for every buy and sell"}</Check>
              <Check ok={reviewLines === 0}>{reviewLines ? `${reviewLines} line(s) flagged to check` : "No line flagged to check"}</Check>
            </ul>
            <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-border pt-3 text-xs">
              <div><dt className="text-muted">Sell</dt><dd className="font-semibold text-red-700">{formatINRCompact(sum(sells, (i) => i.original_target_amount))}</dd></div>
              <div><dt className="text-muted">Buy</dt><dd className="font-semibold text-blue-700">{formatINRCompact(sum(buys, (i) => i.original_target_amount))}</dd></div>
              <div><dt className="text-muted">SIP / mo</dt><dd className="font-semibold text-violet-700">{formatINRCompact(sipMonthly)}</dd></div>
            </dl>
            {canAdvise ? (
              blockers ? (
                <div className="mt-3">
                  <Button className="w-full" disabled>Approve plan</Button>
                  <p className="mt-1.5 text-[11.5px] text-muted">Unlocks when the points above are done.</p>
                </div>
              ) : (
                <ActionForm action={approvePlanAction.bind(null, clientId, planId)} className="mt-3 space-y-2">
                  {replacing ? <Field label="Why replace the current plan? *"><Input name="reason" required /></Field> : <input type="hidden" name="reason" value="" />}
                  <label className="flex items-start gap-2 text-xs">
                    <input type="checkbox" name="confirm" value="yes" className="mt-0.5" required />
                    <span>I have checked every line. {additional ? "Approving adds them to the active plan as a new tranche." : "Approving makes this plan ACTIVE and freezes its targets."} It does not issue any call.</span>
                  </label>
                  <SubmitButton className="w-full">{additional ? "Approve & add to active plan" : "Approve plan"}</SubmitButton>
                </ActionForm>
              )
            ) : <p className="mt-3 text-xs text-muted">An advisor or admin approves this draft.</p>}
            <p className="mt-3 text-[11.5px] leading-snug text-muted">
              On approval: calls you recorded as already done are logged, SIPs the CAS shows started are ticked{replacing ? ", and the old plan moves to history" : ""}.
            </p>
          </section>

          <details className="rounded-xl border border-border bg-surface text-sm">
            <summary className="cursor-pointer select-none px-4 py-2.5 text-muted">Plan details · notes · reject draft</summary>
            <div className="space-y-3 border-t border-border px-4 py-3 text-xs">
              <dl className="grid grid-cols-[90px_minmax(0,1fr)] gap-y-1">
                <dt className="text-muted">Plan</dt><dd>{plan.plan_name}</dd>
                <dt className="text-muted">Source</dt><dd>{humanize(plan.extraction_source)}</dd>
                <dt className="text-muted">At the report</dt><dd><Money value={plan.starting_portfolio_value} /></dd>
                {plan.fresh_money ? <><dt className="text-muted">Fresh money</dt><dd><Money value={plan.fresh_money} /></dd></> : null}
              </dl>
              {plan.notes ? <p className="whitespace-pre-wrap rounded-md bg-slate-50 p-2 text-muted">{plan.notes}</p> : null}
              {canAdvise ? (
                <ActionForm action={closePlanAction.bind(null, clientId, planId)} className="space-y-2 border-t border-border pt-3">
                  <input type="hidden" name="status" value="CANCELLED" />
                  <Field label="Reason to reject this draft *"><Input name="reason" required /></Field>
                  <SubmitButton size="sm" variant="outline" confirm="Reject this draft? It is kept in history and nothing else changes.">Reject draft</SubmitButton>
                </ActionForm>
              ) : null}
            </div>
          </details>
        </aside>
      </div>
    </>
  );
}
