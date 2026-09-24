import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Badge } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { TransitionBar } from "@/components/ui/progress";
import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { Money } from "@/components/app/money";
import { ActionBadge, StatusBadge } from "@/components/app/status-badge";
import { TransitionSummary } from "@/components/app/transition-summary";
import { SecuritySelect } from "@/components/app/security-select";
import { SipTable } from "@/components/app/sip-table";
import { EmptyState } from "@/components/app/page-header";
import { formatDate, formatDateTime, humanize } from "@/lib/format";
import { pageData } from "@/lib/server";
import { getClientSummary } from "@/services/clients";
import { getPlan, getPlanItems, getSipItems } from "@/services/plans";
import { listAllSecurities } from "@/services/securities";
import { getHoldings } from "@/services/portfolio";
import type { PlanItemProgress } from "@/types/domain";
import {
  addPlanItemAction, addSipAction, approvePlanAction, cancelPlanItemAction, closePlanAction, deletePlanItemAction,
  deleteSipAction, resolveSipSecurityAction, updatePlanItemAction,
} from "../actions";
import { setSipStatusAction } from "../../actions";

export const metadata = { title: "Portfolio plan" };

export default async function PlanPage(props: PageProps<"/clients/[id]/plans/[planId]">) {
  const { id, planId } = await props.params;
  const { c, plan, items, sips, securities, heldIds, actor } = await pageData(async (tx) => {
    const c = await getClientSummary(tx, id);
    const plan = await getPlan(tx, planId);
    const holdings = c.latest_snapshot_id ? await getHoldings(tx, c.latest_snapshot_id) : [];
    return {
      c, plan,
      items: await getPlanItems(tx, planId),
      sips: await getSipItems(tx, planId),
      securities: await listAllSecurities(tx),
      heldIds: holdings.map((h) => h.security_id).filter((x): x is string => Boolean(x)),
    };
  });
  const canAdvise = actor.role !== "OPERATIONS";
  const editable = canAdvise && (plan.status === "DRAFT" || plan.status === "ACTIVE");
  const isActive = plan.status === "ACTIVE";
  const actionable = items.filter((i) => i.side !== "NONE" && i.item_status !== "CANCELLED");
  const reviewCount = items.filter((i) => i.needs_review && i.item_status !== "CANCELLED").length + sips.filter((s) => s.needs_review && s.status !== "CANCELLED").length;
  const missingSecurity = actionable.filter((i) => !i.security_id).length;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs text-muted">
            <Link href="/clients" className="hover:underline">Clients</Link> / <Link href={`/clients/${id}`} className="hover:underline">{c.full_name}</Link> / Plan
          </div>
          <h1 className="mt-0.5 flex items-center gap-2 text-xl font-semibold">{plan.plan_name} <StatusBadge status={plan.status} /></h1>
          <div className="mt-1 flex flex-wrap gap-x-4 text-sm text-muted">
            <span>Plan date {formatDate(plan.plan_date)}</span>
            <span>Source: {humanize(plan.extraction_source)}</span>
            <span>Starting value <Money value={plan.starting_portfolio_value} /></span>
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

      {plan.status === "DRAFT" ? (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong>DRAFT</strong> — this plan is not active and does not drive any numbers yet. {plan.extraction_source === "AI_EXTRACTION" ? "It was extracted from a document: verify every line against the report before approving." : ""}
          {reviewCount ? <> <strong>{reviewCount}</strong> line(s) need review.</> : null}
        </div>
      ) : null}
      {plan.notes ? <p className="mb-4 whitespace-pre-wrap rounded-md bg-white p-3 text-sm text-muted ring-1 ring-border">{plan.notes}</p> : null}

      <div className="grid gap-3 lg:grid-cols-2">
        <TransitionSummary side="SELL" n={{ target: plan.sell_target, advised: plan.sell_advised, executed: plan.sell_executed, pending: plan.sell_pending, yetToAdvise: plan.sell_yet_to_advise }} />
        <TransitionSummary side="BUY" n={{ target: plan.buy_target, advised: plan.buy_advised, executed: plan.buy_executed, pending: plan.buy_pending, yetToAdvise: plan.buy_yet_to_advise }} />
      </div>

      {isActive && actionable.length ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {actionable.map((i) => <ItemCard key={i.plan_item_id} i={i} clientId={id} canAdvise={canAdvise} />)}
        </div>
      ) : null}

      <Card className="mt-4">
        <CardHeader><CardTitle>Plan items</CardTitle><span className="text-xs text-muted">SELL side = SELL + SWITCH (switch-out). RETAIN lines move no money.</span></CardHeader>
        {items.length === 0 ? <div className="p-4"><EmptyState title="No items yet" /></div> : (
          <Table className="text-[13px] [&_td]:px-2 [&_th]:px-2">
            <THead>
              <TR>
                <TH>Security</TH><TH>Action</TH><TH className="text-right">Current value</TH><TH className="text-right">Target value</TH>
                <TH className="text-right">Target amount</TH><TH className="text-right">Advised</TH><TH className="text-right">Executed</TH>
                <TH className="text-right">Pending</TH><TH className="text-right">Yet to advise</TH><TH>Status</TH>{editable ? <TH /> : null}
              </TR>
            </THead>
            <TBody>
              {items.map((i) => (
                <TR key={i.plan_item_id} className={i.item_status === "CANCELLED" ? "text-muted line-through decoration-gray-300" : undefined}>
                  <TD className="max-w-72">
                    <div className="truncate font-medium" title={i.scheme_name}>{i.scheme_name}</div>
                    {i.needs_review ? <Badge tone="pending">needs review</Badge> : null}
                    {!i.security_id && i.side !== "NONE" ? <Badge tone="danger">no security</Badge> : null}
                    {i.reason ? <div className="truncate text-[11px] text-muted no-underline" title={i.reason}>{i.reason}</div> : null}
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
                  </TD>
                  {editable ? (
                    <TD className="min-w-24">
                      {i.item_status !== "CANCELLED" ? (
                        <ItemEditor i={i} clientId={id} planId={planId} isActive={isActive} securities={securities} heldIds={heldIds} />
                      ) : null}
                    </TD>
                  ) : null}
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      {editable ? (
        <Card className="mt-4">
          <CardHeader><CardTitle>Add plan item</CardTitle></CardHeader>
          <CardContent>
            <ActionForm action={addPlanItemAction.bind(null, id, planId)} className="grid gap-3 md:grid-cols-6" resetOnSuccess>
              <Field label="Security" className="md:col-span-2"><SecuritySelect securities={securities} heldIds={heldIds} required /></Field>
              <Field label="Action">
                <Select name="action" defaultValue="BUY"><option>BUY</option><option>SELL</option><option>SWITCH</option><option>RETAIN</option></Select>
              </Field>
              <Field label="Target amount (₹)"><Input name="target_amount" inputMode="decimal" placeholder="e.g. 500000" /></Field>
              <Field label="Current value (₹)"><Input name="current_amount" inputMode="decimal" /></Field>
              <Field label="Target weight %"><Input name="target_weight" inputMode="decimal" /></Field>
              <Field label="Reason" className="md:col-span-3"><Input name="reason" /></Field>
              {isActive ? <Field label="Why add to an ACTIVE plan? *" className="md:col-span-3"><Input name="change_reason" required /></Field> : null}
              <div className="md:col-span-6"><SubmitButton size="sm">Add item</SubmitButton></div>
            </ActionForm>
          </CardContent>
        </Card>
      ) : null}

      <Card className="mt-4">
        <CardHeader><CardTitle>SIP plan (tracked separately from lump sums)</CardTitle><span className="text-xs text-muted">Target SIP <Money value={plan.target_sip_value} full />/month</span></CardHeader>
        {sips.length ? (
          <SipTable rows={sips} canUpdate={isActive} action={isActive ? setSipStatusAction.bind(null, id) : undefined} />
        ) : <CardContent><p className="text-sm text-muted">No SIP actions.</p></CardContent>}
        {editable && sips.some((s) => s.needs_review || plan.status === "DRAFT") ? (
          <CardContent className="space-y-2 border-t border-border">
            {sips.filter((s) => s.needs_review).map((s) => (
              <ActionForm key={s.id} action={resolveSipSecurityAction.bind(null, id, planId, s.id)} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="w-72 truncate">Confirm security for <strong>{s.scheme_name}</strong>:</span>
                <SecuritySelect securities={securities} heldIds={heldIds} className="w-96" required />
                <SubmitButton size="sm" variant="outline">Confirm</SubmitButton>
              </ActionForm>
            ))}
            {plan.status === "DRAFT" ? sips.map((s) => (
              <ActionForm key={`d-${s.id}`} action={deleteSipAction.bind(null, id, planId, s.id)} className="inline-block">
                <SubmitButton size="sm" variant="ghost" confirm="Remove this SIP line from the draft?">Remove {s.action} {s.scheme_name.slice(0, 30)}</SubmitButton>
              </ActionForm>
            )) : null}
          </CardContent>
        ) : null}
        {editable ? (
          <CardContent className="border-t border-border">
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
        ) : null}
      </Card>

      {plan.status === "DRAFT" && canAdvise ? (
        <Card className="mt-4 border-brand/30">
          <CardHeader><CardTitle>Approve plan</CardTitle></CardHeader>
          <CardContent>
            {missingSecurity || reviewCount ? (
              <p className="mb-3 text-sm text-red-700">Resolve {missingSecurity ? `${missingSecurity} item(s) without a security` : ""}{missingSecurity && reviewCount ? " and " : ""}{reviewCount ? `${reviewCount} line(s) flagged "needs review"` : ""} first. The database refuses approval otherwise.</p>
            ) : null}
            <ActionForm action={approvePlanAction.bind(null, id, planId)} className="space-y-3">
              {c.active_plan_id && c.active_plan_id !== planId ? (
                <Field label="Reason for replacing the current ACTIVE plan *"><Input name="reason" required /></Field>
              ) : <input type="hidden" name="reason" value="" />}
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" name="confirm" value="yes" className="mt-1" />
                <span>I have reviewed every line. Approving makes this plan ACTIVE and freezes its approved targets. It does <strong>not</strong> issue any call to the client.</span>
              </label>
              <SubmitButton>Approve &amp; activate</SubmitButton>
            </ActionForm>
          </CardContent>
        </Card>
      ) : null}

      {canAdvise && (plan.status === "ACTIVE" || plan.status === "DRAFT") ? (
        <Card className="mt-4">
          <CardHeader><CardTitle>Close plan</CardTitle></CardHeader>
          <CardContent>
            <ActionForm action={closePlanAction.bind(null, id, planId)} className="flex flex-wrap items-end gap-2">
              <Field label="New status">
                <Select name="status" className="w-40">
                  {plan.status === "ACTIVE" ? <option value="COMPLETED">Completed</option> : null}
                  <option value="CANCELLED">Cancelled</option>
                </Select>
              </Field>
              <Field label="Reason *" className="w-96"><Input name="reason" required /></Field>
              <SubmitButton variant="outline" confirm="Close this plan? This cannot be undone.">Close plan</SubmitButton>
            </ActionForm>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}

function ItemCard({ i, clientId, canAdvise }: { i: PlanItemProgress; clientId: string; canAdvise: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-white p-3 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 text-sm font-medium leading-tight" title={i.scheme_name}><span className="line-clamp-2">{i.scheme_name}</span></div>
        <ActionBadge action={i.action} />
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted">Current</dt><dd className="text-right"><Money value={i.current_amount} /></dd>
        <dt className="text-muted">Target</dt><dd className="text-right"><Money value={i.target_value} /></dd>
        <dt className="text-muted">{i.side === "SELL" ? "Planned exit" : "Planned buy"}</dt><dd className="text-right font-medium"><Money value={i.target_amount} /></dd>
        <dt className="text-muted">Advised</dt><dd className="text-right text-blue-700"><Money value={i.advised_amount} /></dd>
        <dt className="text-muted">Executed</dt><dd className="text-right text-emerald-700"><Money value={i.executed_amount} /></dd>
        <dt className="text-muted">Pending</dt><dd className="text-right text-amber-700"><Money value={i.pending_amount} /></dd>
        <dt className="text-muted">Remaining to advise</dt><dd className="text-right font-semibold"><Money value={i.yet_to_advise_amount} /></dd>
      </dl>
      <TransitionBar className="mt-2" target={i.target_amount} executed={i.executed_amount} pending={i.pending_amount} />
      {canAdvise && i.yet_to_advise_amount > 0 ? (
        <Link href={`/advice/new?client=${clientId}&planItem=${i.plan_item_id}`} className="mt-2 inline-block text-xs text-brand hover:underline">
          Issue call for remaining →
        </Link>
      ) : null}
    </div>
  );
}

function ItemEditor({ i, clientId, planId, isActive, securities, heldIds }: {
  i: PlanItemProgress; clientId: string; planId: string; isActive: boolean;
  securities: Awaited<ReturnType<typeof listAllSecurities>>; heldIds: string[];
}) {
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-brand">{isActive ? "Amend" : "Edit"}</summary>
      <div className="absolute right-8 z-30 mt-1 w-[520px] rounded-lg border border-border bg-white p-3 shadow-lg">
        <ActionForm action={updatePlanItemAction.bind(null, clientId, planId, i.plan_item_id)} className="grid grid-cols-2 gap-2">
          <Field label="Security" className="col-span-2"><SecuritySelect securities={securities} heldIds={heldIds} defaultValue={i.security_id} /></Field>
          <input type="hidden" name="scheme_name" value={i.scheme_name} />
          <input type="hidden" name="folio_number" value={i.folio_number ?? ""} />
          <Field label="Action">
            <Select name="action" defaultValue={i.action}><option>SELL</option><option>SWITCH</option><option>BUY</option><option>RETAIN</option></Select>
          </Field>
          <Field label="Target amount (₹)"><Input name="target_amount" defaultValue={i.original_target_amount || ""} /></Field>
          <Field label="Current value (₹)"><Input name="current_amount" defaultValue={i.current_amount ?? ""} /></Field>
          <Field label="Target units"><Input name="target_units" defaultValue={i.target_units ?? ""} /></Field>
          <Field label="Target weight %"><Input name="target_weight" defaultValue={i.target_weight ?? ""} /></Field>
          <Field label="Priority"><Input name="priority" defaultValue={i.priority} /></Field>
          <Field label="Reason" className="col-span-2"><Textarea name="reason" rows={2} defaultValue={i.reason ?? ""} /></Field>
          {isActive ? <Field label="Reason for amending an ACTIVE plan *" className="col-span-2"><Input name="change_reason" required /></Field> : null}
          <div className="col-span-2"><SubmitButton size="sm">Save</SubmitButton></div>
        </ActionForm>
        <div className="mt-3 border-t border-border pt-3">
          {isActive ? (
            <ActionForm action={cancelPlanItemAction.bind(null, clientId, planId, i.plan_item_id)} className="flex gap-2">
              <Input name="reason" placeholder="Reason to cancel this item" required />
              <SubmitButton size="sm" variant="danger">Cancel item</SubmitButton>
            </ActionForm>
          ) : (
            <ActionForm action={deletePlanItemAction.bind(null, clientId, planId, i.plan_item_id)}>
              <SubmitButton size="sm" variant="danger" confirm="Delete this line from the draft?">Delete from draft</SubmitButton>
            </ActionForm>
          )}
        </div>
      </div>
    </details>
  );
}
