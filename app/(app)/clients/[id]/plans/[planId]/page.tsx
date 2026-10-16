import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Field, Input, Select } from "@/components/ui/form";
import { Badge } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { TransitionBar } from "@/components/ui/progress";
import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { Money } from "@/components/app/money";
import { ActionBadge, StatusBadge } from "@/components/app/status-badge";
import { TransitionSummary } from "@/components/app/transition-summary";
import { SecuritySelect } from "@/components/app/security-select";
import { SipTable } from "@/components/app/sip-table";
import { UnchangedSips } from "@/components/app/sip-status-card";
import { getSipStatus } from "@/services/sip-status";
import { EmptyState } from "@/components/app/page-header";
import { formatDate, formatDateTime, humanize } from "@/lib/format";
import { pageData } from "@/lib/server";
import { getClientSummary } from "@/services/clients";
import { getPlan, getPlanItems, getSipItems, getTranches, listReportQuestions } from "@/services/plans";
import { ReportQuestions } from "./questions";
import { ItemEditor } from "./item-editor";
import { DraftView } from "./draft-view";
import { AsReportedNote } from "./as-reported-note";
import { getSipProgress } from "@/services/sip";
import { countMigrateNotes } from "@/services/migrations";
import { listAllSecurities } from "@/services/securities";
import { getHoldings } from "@/services/portfolio";
import {
  addPlanItemAction, addSipAction, closePlanAction, convertMigrateNotesAction, resolveSipSecurityAction,
  convertSipToLumpsumAction, updateSipAmountsAction,
} from "../actions";
import { setSipStatusAction } from "../../actions";
import { AppError } from "@/lib/errors";

export const metadata = { title: "Portfolio plan" };

export default async function PlanPage(props: PageProps<"/clients/[id]/plans/[planId]">) {
  const { id, planId } = await props.params;
  const sp = await props.searchParams;
  const { c, plan, items: allItems, sips, sipProgress, sipSeen, securities, heldIds, tranches, migrateNotes, questions, actor } = await pageData(async (tx) => {
    const c = await getClientSummary(tx, id);
    const plan = await getPlan(tx, planId);
    if (plan.client_id !== id) throw new AppError("Plan not found for this client.", "NOT_FOUND");
    const holdings = c.latest_snapshot_id ? await getHoldings(tx, c.latest_snapshot_id) : [];
    return {
      c, plan,
      items: await getPlanItems(tx, planId),
      sips: await getSipItems(tx, planId),
      sipProgress: await getSipProgress(tx, planId),
      // SIPs the report keeps as they are (shown on the active plan, with what the CAS says).
      sipSeen: plan.status === "ACTIVE" ? await getSipStatus(tx, id) : null,
      tranches: await getTranches(tx, planId),
      migrateNotes: await countMigrateNotes(tx, planId),
      questions: await listReportQuestions(tx, planId),
      securities: await listAllSecurities(tx),
      heldIds: holdings.map((h) => h.security_id).filter((x): x is string => Boolean(x)),
    };
  });
  const canAdvise = actor.role !== "OPERATIONS";
  if (plan.status === "DRAFT") {
    return (
      <DraftView c={c} plan={plan} items={allItems} sips={sips} questions={questions} securities={securities} heldIds={heldIds}
        migrateNotes={migrateNotes} canAdvise={canAdvise} clientId={id} planId={planId} onboarded={typeof sp.onboarded === "string" ? sp.onboarded : null} />
    );
  }
  const items = allItems;
  const editable = canAdvise && plan.status === "ACTIVE";
  const isActive = plan.status === "ACTIVE";

  return (
    <>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs text-muted">
            <Link href="/clients" className="hover:underline">Clients</Link> / <Link href={`/clients/${id}`} className="hover:underline">{c.full_name}</Link> / Plan
          </div>
          <h1 className="mt-0.5 flex items-center gap-2 text-xl font-semibold">
            {plan.plan_name} <StatusBadge status={plan.status} />
            {plan.plan_kind === "ADDITIONAL" ? <Badge tone="info">Additional investment</Badge> : null}
          </h1>
          <div className="mt-1 flex flex-wrap gap-x-4 text-sm text-muted">
            <span>Plan date {formatDate(plan.plan_date)}</span>
            <span>Source: {humanize(plan.extraction_source)}</span>
            <span>Starting value <Money value={plan.starting_portfolio_value} /></span>
            {plan.fresh_money ? <span>Fresh money <Money value={plan.fresh_money} /></span> : null}
            {plan.approved_at ? <span>Approved {formatDateTime(plan.approved_at)}</span> : null}
            {plan.approved_target_exit_value != null && plan.approved_target_exit_value !== plan.target_exit_value ? (
              <span className="text-amber-700">Amended since approval (approved exit <Money value={plan.approved_target_exit_value} />)</span>
            ) : null}
          </div>
        </div>
        {isActive && canAdvise ? (
          <div className="flex gap-2">
            <LinkButton href={`/advice/new?client=${id}&side=SELL`} variant="outline" size="sm">Issue sell call</LinkButton>
            <LinkButton href={`/advice/new?client=${id}&side=BUY`} size="sm">Issue buy call</LinkButton>
          </div>
        ) : null}
      </div>

      {plan.status === "MERGED" && plan.merged_into_plan_id ? (
        <div className="mb-4 rounded-lg border border-border bg-gray-50 px-4 py-3 text-sm">
          Added to the <Link className="text-brand hover:underline" href={`/clients/${id}/plans/${plan.merged_into_plan_id}`}>active plan</Link> as a tranche
          {plan.approved_at ? ` on ${formatDateTime(plan.approved_at)}` : ""}. Calls are issued and tracked there.
        </div>
      ) : null}
      {plan.as_reported ? <AsReportedNote a={plan.as_reported} className="mb-4" /> : null}
      {plan.notes ? <p className="mb-4 whitespace-pre-wrap rounded-md bg-white p-3 text-sm text-muted ring-1 ring-border">{plan.notes}</p> : null}

      <div className="grid gap-3 lg:grid-cols-2">
        <TransitionSummary side="SELL" n={{ target: plan.sell_target, advised: plan.sell_advised, executed: plan.sell_executed, pending: plan.sell_pending, yetToAdvise: plan.sell_yet_to_advise }} />
        <TransitionSummary side="BUY" n={{ target: plan.buy_target, advised: plan.buy_advised, executed: plan.buy_executed, pending: plan.buy_pending, yetToAdvise: plan.buy_yet_to_advise }} />
      </div>

      {questions.length ? <ReportQuestions rows={questions} clientId={id} planId={planId} canAnswer={editable} /> : null}

      {migrateNotes > 0 && editable ? (
        <Card className="mt-4 border-sky-200">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <span><strong>{migrateNotes}</strong> Regular fund(s) say &ldquo;Migrate to Direct&rdquo; only as a note on a Keep line.</span>
            <ActionForm action={convertMigrateNotesAction.bind(null, id, planId)}>
              <SubmitButton size="sm">Turn them into Sell (Regular) + Buy (Direct)</SubmitButton>
            </ActionForm>
          </CardContent>
        </Card>
      ) : null}

      <Card className="mt-4">
        <CardHeader><CardTitle>Plan lines · {items.length}</CardTitle><span className="text-xs text-muted">Every fund is Buy, Sell or Keep. Keep lines move no money. Done fills in from each new CAS.</span></CardHeader>
        {items.length === 0 ? <div className="p-4"><EmptyState title="No items yet" /></div> : (
          <Table className="text-[13px] [&_td]:px-2 [&_th]:px-2">
            <THead>
              <TR>
                <TH>Security</TH><TH>Action</TH><TH className="text-right">Current value</TH><TH className="text-right">Target value</TH>
                <TH className="text-right">Target amount</TH><TH className="text-right">Advised</TH><TH className="text-right">Done</TH>
                <TH className="text-right">Waiting</TH><TH className="text-right">Left to advise</TH><TH>Status</TH>
              </TR>
            </THead>
            <TBody>
              {items.map((i) => (
                <TR key={i.plan_item_id} className={i.item_status === "CANCELLED" ? "text-muted line-through decoration-gray-300" : undefined}>
                  <TD className="max-w-72">
                    <div className="truncate font-medium" title={i.scheme_name}>{i.scheme_name}</div>
                    {tranches[i.plan_item_id] ? (
                      <Link href={`/clients/${id}/plans/${tranches[i.plan_item_id].plan_id}`} title={tranches[i.plan_item_id].plan_name}>
                        <Badge tone="info">Tranche · {formatDate(tranches[i.plan_item_id].plan_date)}</Badge>
                      </Link>
                    ) : null}
                    {i.needs_review ? <Badge tone="pending">needs review</Badge> : null}
                    {!i.security_id && i.side !== "NONE" ? <Badge tone="danger">no security</Badge> : null}
                    {i.reason ? <div className="truncate text-[11px] text-muted no-underline" title={i.reason}>{i.reason}</div> : null}
                    {editable && i.item_status !== "CANCELLED" ? (
                      <ItemEditor i={i} clientId={id} planId={planId} isActive={isActive} securities={securities} heldIds={heldIds} />
                    ) : null}
                  </TD>
                  <TD><ActionBadge action={i.action} /></TD>
                  <TD className="text-right"><Money value={i.current_amount} /></TD>
                  <TD className="text-right"><Money value={i.target_value} /></TD>
                  <TD className="text-right font-medium"><Money value={i.side === "NONE" ? null : i.original_target_amount} /></TD>
                  <TD className="text-right text-blue-700"><Money value={i.side === "NONE" ? null : i.advised_amount} /></TD>
                  <TD className="text-right text-emerald-700"><Money value={i.side === "NONE" ? null : i.executed_amount} /></TD>
                  <TD className="text-right text-amber-700"><Money value={i.side === "NONE" ? null : i.pending_amount} /></TD>
                  <TD className="text-right"><Money value={i.side === "NONE" ? null : i.yet_to_advise_amount} />{i.over_advised_amount > 0 ? <div className="text-[10px] text-red-700">over by <Money value={i.over_advised_amount} /></div> : null}</TD>
                  <TD className="min-w-32">
                    <StatusBadge status={i.item_status === "CANCELLED" ? "CANCELLED" : i.progress_status} />
                    {i.side !== "NONE" ? <TransitionBar className="mt-1" target={i.target_amount} executed={i.executed_amount} pending={i.pending_amount} /> : null}
                    {isActive && canAdvise && i.side !== "NONE" && i.item_status !== "CANCELLED" && i.yet_to_advise_amount > 0.5 ? (
                      <Link href={`/advice/new?client=${id}&planItem=${i.plan_item_id}`} className="mt-1 block text-[11px] text-brand hover:underline">Issue call →</Link>
                    ) : null}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      {editable ? (
        <details className="mt-4 rounded-xl border border-border bg-surface">
          <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-semibold">+ Add a plan line</summary>
          <CardContent className="border-t border-border pt-3">
            <ActionForm action={addPlanItemAction.bind(null, id, planId)} className="grid gap-3 md:grid-cols-6" resetOnSuccess>
              <Field label="Security" className="md:col-span-2"><SecuritySelect securities={securities} heldIds={heldIds} required /></Field>
              <Field label="Action">
                <Select name="action" defaultValue="BUY"><option>BUY</option><option>SELL</option><option value="RETAIN">KEEP</option></Select>
              </Field>
              <Field label="Target amount (₹)"><Input name="target_amount" inputMode="decimal" placeholder="e.g. 500000" /></Field>
              <Field label="Current value (₹)"><Input name="current_amount" inputMode="decimal" /></Field>
              <Field label="Target weight %"><Input name="target_weight" inputMode="decimal" /></Field>
              <Field label="Reason" className="md:col-span-3"><Input name="reason" /></Field>
              {isActive ? <Field label="Why add to an ACTIVE plan? *" className="md:col-span-3"><Input name="change_reason" required /></Field> : null}
              <div className="md:col-span-6"><SubmitButton size="sm">Add item</SubmitButton></div>
            </ActionForm>
          </CardContent>
        </details>
      ) : null}

      <Card className="mt-4">
        <CardHeader><CardTitle>SIP lines · {sips.length}</CardTitle><span className="text-xs text-muted">Target SIP <Money value={plan.target_sip_value} full />/month</span></CardHeader>
        {sipSeen?.continuing.length ? <UnchangedSips sip={sipSeen} className="border-b border-border px-4 py-3" /> : null}
        {sips.length ? (
          <SipTable
            rows={sips}
            canUpdate={editable}
            action={editable ? setSipStatusAction.bind(null, id) : undefined}
            invested={Object.fromEntries(sipProgress.map((r) => [r.sip_item_id, r]))}
            extra={editable ? (s) => s.status === "CANCELLED" || s.status === "COMPLETED" ? null : (
              <details className="text-xs">
                <summary className="cursor-pointer text-brand">Change / → lump sum</summary>
                <div className="mt-2 space-y-2">
                  <ActionForm action={updateSipAmountsAction.bind(null, id, planId, s.id)} className="flex flex-wrap items-end gap-1">
                    {s.action !== "START" ? <Field label="Old ₹"><Input name="old_amount" className="h-8 w-24 text-xs" defaultValue={s.old_amount ?? ""} /></Field> : null}
                    {s.action !== "STOP" ? <Field label="New ₹/instalment"><Input name="new_amount" className="h-8 w-28 text-xs" defaultValue={s.new_amount ?? ""} /></Field> : null}
                    <Field label="Day"><Input name="debit_day" className="h-8 w-14 text-xs" defaultValue={s.debit_day ?? ""} /></Field>
                    <Field label="Reason *"><Input name="reason" className="h-8 w-40 text-xs" required /></Field>
                    <SubmitButton size="sm" variant="outline">Save</SubmitButton>
                  </ActionForm>
                  {s.action !== "STOP" && s.security_id ? (
                    <ActionForm action={convertSipToLumpsumAction.bind(null, id, planId, s.id)} className="flex flex-wrap items-end gap-1">
                      <Field label="Lump sum ₹ *"><Input name="lumpsum_amount" className="h-8 w-28 text-xs" required /></Field>
                      <Field label="Reason *"><Input name="reason" className="h-8 w-40 text-xs" required /></Field>
                      <SubmitButton size="sm" variant="outline" confirm="Cancel this SIP line and add a lump-sum buy instead?">Make lump sum</SubmitButton>
                    </ActionForm>
                  ) : null}
                </div>
              </details>
            ) : undefined}
          />
        ) : <CardContent><p className="text-sm text-muted">No SIP actions.</p></CardContent>}
        {editable && sips.some((s) => s.needs_review) ? (
          <CardContent className="space-y-2 border-t border-border">
            {sips.filter((s) => s.needs_review).map((s) => (
              <ActionForm key={s.id} action={resolveSipSecurityAction.bind(null, id, planId, s.id)} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="w-72 truncate">Confirm security for <strong>{s.scheme_name}</strong>:</span>
                <SecuritySelect securities={securities} heldIds={heldIds} className="w-96" required />
                <SubmitButton size="sm" variant="outline">Confirm</SubmitButton>
              </ActionForm>
            ))}
          </CardContent>
        ) : null}
        {editable ? (
          <details className="border-t border-border">
          <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-medium text-brand">+ Add a SIP line</summary>
          <CardContent className="pt-0">
            <ActionForm action={addSipAction.bind(null, id, planId)} className="grid gap-3 md:grid-cols-7" resetOnSuccess>
              <Field label="Scheme" className="md:col-span-2"><SecuritySelect securities={securities} heldIds={heldIds} required /></Field>
              <Field label="Action"><Select name="action"><option>START</option><option>STOP</option><option>CHANGE</option></Select></Field>
              <Field label="Old ₹/instalment"><Input name="old_amount" inputMode="decimal" /></Field>
              <Field label="New ₹/instalment"><Input name="new_amount" inputMode="decimal" /></Field>
              <Field label="Frequency"><Select name="frequency" defaultValue="MONTHLY"><option>MONTHLY</option><option>WEEKLY</option><option>DAILY</option><option>QUARTERLY</option></Select></Field>
              <Field label="Debit day"><Input name="debit_day" inputMode="numeric" /></Field>
              {isActive ? <Field label="Why add to an ACTIVE plan? *" className="md:col-span-4"><Input name="change_reason" required /></Field> : null}
              <div className="md:col-span-7"><SubmitButton size="sm" variant="outline">Add SIP action</SubmitButton></div>
            </ActionForm>
          </CardContent>
          </details>
        ) : null}
      </Card>

      {canAdvise && plan.status === "ACTIVE" ? (
        <details className="mt-4 rounded-xl border border-border bg-surface">
          <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-semibold">Close the plan</summary>
          <CardContent className="border-t border-border pt-3">
            <ActionForm action={closePlanAction.bind(null, id, planId)} className="flex flex-wrap items-end gap-2">
              <Field label="New status">
                <Select name="status" className="w-40">
                  <option value="COMPLETED">Completed</option>
                  <option value="CANCELLED">Cancelled</option>
                </Select>
              </Field>
              <Field label="Reason *" className="w-96"><Input name="reason" required /></Field>
              <SubmitButton variant="outline" confirm="Close this plan? This cannot be undone.">Close plan</SubmitButton>
            </ActionForm>
          </CardContent>
        </details>
      ) : null}
    </>
  );
}
