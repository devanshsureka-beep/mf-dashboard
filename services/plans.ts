import { syncSipLinesQuietly } from "@/services/sip-status";
import type { Actor, Tx } from "@/lib/db/tx";
import { setAuditReason } from "@/lib/db/tx";
import { AppError } from "@/lib/errors";
import type { AdvisoryReportResult } from "@/lib/integrations/contracts";
import type { PlanItemProgress, PlanRow, PlanTransition, SipItem } from "@/types/domain";
import { suggestSecurity } from "./securities";
import { issueAdvice } from "./advice";
import { recordExecution } from "./executions";
import { MIGRATE_BUY_REASON, migrateSellReason, switchBuyReason, type ReportDiff } from "@/lib/domain/report-plan";
import type { SecurityCandidate } from "@/lib/domain/securities";

// -----------------------------------------------------------------------------
// Queries
// -----------------------------------------------------------------------------
export async function listPlans(tx: Tx, clientId: string): Promise<(PlanRow & PlanTransition)[]> {
  return tx<(PlanRow & PlanTransition)[]>`
    select p.*, t.sell_target, t.sell_advised, t.sell_executed, t.sell_pending, t.sell_yet_to_advise, t.sell_over_advised,
           t.buy_target, t.buy_advised, t.buy_executed, t.buy_pending, t.buy_yet_to_advise, t.buy_over_advised,
           t.actionable_items, t.completed_items
    from public.advisory_plans p join public.v_plan_transition t on t.plan_id = p.id
    where p.client_id = ${clientId}
    order by (p.status = 'ACTIVE') desc, p.plan_date desc, p.created_at desc`;
}

export async function getPlan(tx: Tx, planId: string): Promise<PlanRow & PlanTransition> {
  const rows = await tx<(PlanRow & PlanTransition)[]>`
    select p.*, t.sell_target, t.sell_advised, t.sell_executed, t.sell_pending, t.sell_yet_to_advise, t.sell_over_advised,
           t.buy_target, t.buy_advised, t.buy_executed, t.buy_pending, t.buy_yet_to_advise, t.buy_over_advised,
           t.actionable_items, t.completed_items
    from public.advisory_plans p join public.v_plan_transition t on t.plan_id = p.id
    where p.id = ${planId}`;
  if (!rows[0]) throw new AppError("Plan not found.", "NOT_FOUND");
  return rows[0];
}

export async function getActivePlanId(tx: Tx, clientId: string): Promise<string | null> {
  const rows = await tx<{ id: string }[]>`
    select id from public.advisory_plans where client_id = ${clientId} and status = 'ACTIVE'`;
  return rows[0]?.id ?? null;
}

export async function getPlanItems(tx: Tx, planId: string): Promise<PlanItemProgress[]> {
  return tx<PlanItemProgress[]>`
    select * from public.v_plan_item_progress where plan_id = ${planId}
    order by case side when 'SELL' then 0 when 'BUY' then 1 else 2 end, priority, scheme_name`;
}

/** Open plan items with remaining quantity to advise, for the Issue Call form. */
export async function getAdvisablePlanItems(tx: Tx, clientId: string): Promise<PlanItemProgress[]> {
  return tx<PlanItemProgress[]>`
    select v.* from public.v_plan_item_progress v
    where v.client_id = ${clientId} and v.plan_status = 'ACTIVE' and v.side <> 'NONE'
      and v.item_status = 'OPEN'
    order by v.side desc, v.priority, v.scheme_name`;
}

export async function getSipItems(tx: Tx, planId: string): Promise<SipItem[]> {
  return tx<SipItem[]>`
    select * from public.sip_plan_items where plan_id = ${planId}
    order by case action when 'STOP' then 0 when 'CHANGE' then 1 else 2 end, scheme_name`;
}

// -----------------------------------------------------------------------------
// Draft lifecycle
// -----------------------------------------------------------------------------
export interface CreateDraftInput {
  clientId: string;
  planName: string;
  planDate?: string | null;
  notes?: string | null;
  /** Pre-fill a RETAIN item for every holding of this snapshot. */
  fromSnapshotId?: string | null;
}

export async function createDraftPlan(tx: Tx, actor: Actor, input: CreateDraftInput): Promise<string> {
  let startingValue: number | null = null;
  if (input.fromSnapshotId) {
    const s = await tx<{ total_current_value: number; client_id: string; review_status: string }[]>`
      select total_current_value, client_id, review_status from public.portfolio_snapshots where id = ${input.fromSnapshotId}`;
    if (!s[0] || s[0].client_id !== input.clientId) throw new AppError("Snapshot does not belong to this client.");
    if (s[0].review_status !== "CONFIRMED") throw new AppError("Plans can only be based on a CONFIRMED snapshot.");
    startingValue = s[0].total_current_value;
  }
  const rows = await tx<{ id: string }[]>`
    insert into public.advisory_plans (client_id, plan_name, plan_date, notes, baseline_snapshot_id, starting_portfolio_value, created_by)
    values (${input.clientId}, ${input.planName}, coalesce(${input.planDate || null}::date, app.today_ist()),
            ${input.notes ?? null}, ${input.fromSnapshotId ?? null}, ${startingValue}, ${actor.id})
    returning id`;
  const planId = rows[0].id;

  if (input.fromSnapshotId) {
    await tx`
      insert into public.advisory_plan_items (plan_id, client_id, security_id, scheme_name, folio_number, action,
                                              target_amount, current_amount, priority, created_by)
      select ${planId}, ${input.clientId}, h.security_id, h.scheme_name,
             string_agg(distinct h.folio_number, ', '), 'RETAIN', 0, sum(h.current_value), 100, ${actor.id}
      from public.portfolio_holdings h
      where h.snapshot_id = ${input.fromSnapshotId}
      group by h.security_id, h.scheme_name`;
  }
  return planId;
}

export interface PlanItemInput {
  security_id: string | null;
  scheme_name: string;
  folio_number?: string | null;
  action: "SELL" | "BUY" | "RETAIN";
  target_amount: number;
  target_units?: number | null;
  current_amount?: number | null;
  target_weight?: number | null;
  reason?: string | null;
  priority?: number | null;
  notes?: string | null;
}

async function assertPlanStatus(tx: Tx, planId: string, allowed: string[]): Promise<{ client_id: string; status: string }> {
  const rows = await tx<{ client_id: string; status: string }[]>`
    select client_id, status from public.advisory_plans where id = ${planId}`;
  if (!rows[0]) throw new AppError("Plan not found.", "NOT_FOUND");
  if (!allowed.includes(rows[0].status)) throw new AppError(`This action is not possible while the plan is ${rows[0].status}.`);
  return rows[0];
}

/** Add an item. On an ACTIVE plan a reason is mandatory (enforced in DB too). */
export async function addPlanItem(tx: Tx, actor: Actor, planId: string, item: PlanItemInput, reason?: string | null): Promise<string> {
  const plan = await assertPlanStatus(tx, planId, ["DRAFT", "ACTIVE"]);
  if (plan.status === "ACTIVE") {
    if (!reason?.trim()) throw new AppError("Adding an item to an ACTIVE plan requires a reason.");
    await setAuditReason(tx, reason);
  }
  const rows = await tx<{ id: string }[]>`
    insert into public.advisory_plan_items
      (plan_id, client_id, security_id, scheme_name, folio_number, action, target_amount, target_units, current_amount,
       target_weight, reason, priority, notes, created_by)
    values (${planId}, ${plan.client_id}, ${item.security_id}, ${item.scheme_name}, ${item.folio_number ?? null},
            ${item.action}, ${item.target_amount}, ${item.target_units ?? null}, ${item.current_amount ?? null},
            ${item.target_weight ?? null}, ${item.reason ?? null}, ${item.priority ?? 100}, ${item.notes ?? null}, ${actor.id})
    returning id`;
  return rows[0].id;
}

/** Edit an item. DRAFT: free edit. ACTIVE: amendment with mandatory reason (audited). */
export async function updatePlanItem(tx: Tx, itemId: string, item: PlanItemInput, reason?: string | null): Promise<void> {
  const rows = await tx<{ plan_id: string }[]>`select plan_id from public.advisory_plan_items where id = ${itemId}`;
  if (!rows[0]) throw new AppError("Plan item not found.", "NOT_FOUND");
  const plan = await assertPlanStatus(tx, rows[0].plan_id, ["DRAFT", "ACTIVE"]);
  if (plan.status === "ACTIVE") {
    if (!reason?.trim()) throw new AppError("Amending an ACTIVE plan requires a reason.");
    await setAuditReason(tx, reason);
  }
  await tx`
    update public.advisory_plan_items set
      security_id = ${item.security_id}, scheme_name = ${item.scheme_name}, folio_number = ${item.folio_number ?? null},
      action = ${item.action}, target_amount = ${item.target_amount}, target_units = ${item.target_units ?? null},
      current_amount = ${item.current_amount ?? null}, target_weight = ${item.target_weight ?? null},
      reason = ${item.reason ?? null}, priority = ${item.priority ?? 100}, notes = ${item.notes ?? null},
      -- A report question stays open (and blocks approval) until it is answered on the plan.
      needs_review = case when ${item.security_id}::uuid is null then needs_review
                          else (report_question is not null and report_answer is null) end
    where id = ${itemId}`;
}

export async function deleteDraftPlanItem(tx: Tx, itemId: string): Promise<void> {
  const res = await tx`
    delete from public.advisory_plan_items i using public.advisory_plans p
    where i.id = ${itemId} and p.id = i.plan_id and p.status = 'DRAFT'`;
  if (res.count === 0) throw new AppError("Only items of a DRAFT plan can be deleted. Cancel the item instead.");
}

export async function cancelPlanItem(tx: Tx, itemId: string, reason: string): Promise<void> {
  if (!reason.trim()) throw new AppError("A reason is required.");
  await setAuditReason(tx, reason);
  const res = await tx`
    update public.advisory_plan_items set status = 'CANCELLED', notes = coalesce(notes || E'\n', '') || ${`Cancelled: ${reason}`}
    where id = ${itemId} and status <> 'CANCELLED'`;
  if (res.count === 0) throw new AppError("Plan item not found or already cancelled.");
}

/**
 * Approve a DRAFT plan -> ACTIVE. A currently ACTIVE plan of the client becomes
 * REPLACED (with reason). The DB freezes approved targets and blocks approval
 * while any item still needs review or lacks a security.
 */
export async function approvePlan(
  tx: Tx,
  actor: Actor,
  planId: string,
  reason?: string | null,
  approvedAt: Date = new Date(),
): Promise<"ACTIVE" | "MERGED"> {
  const plan = await assertPlanStatus(tx, planId, ["DRAFT"]);
  const items = await tx<{ n: number }[]>`
    select count(*)::int as n from public.advisory_plan_items where plan_id = ${planId} and status <> 'CANCELLED'`;
  const sips = await tx<{ n: number }[]>`select count(*)::int as n from public.sip_plan_items where plan_id = ${planId}`;
  if (items[0].n + sips[0].n === 0) throw new AppError("A plan needs at least one item before approval.");

  // The report this plan came from has been reviewed: it no longer needs review.
  await tx`
    update public.documents set parse_status = 'PARSED'
    where id = (select source_document_id from public.advisory_plans where id = ${planId}) and parse_status = 'NEEDS_REVIEW'`;
  const current = await getActivePlanId(tx, plan.client_id);
  const meta = await tx<{ plan_kind: string; fresh_money: number | null; plan_name: string; plan_date: string }[]>`
    select plan_kind, fresh_money, plan_name, plan_date::text from public.advisory_plans where id = ${planId}`;
  if (meta[0]?.plan_kind === "ADDITIONAL" && current) {
    await mergeAdditionalPlan(tx, actor, { planId, activePlanId: current, clientId: plan.client_id, ...meta[0] }, reason, approvedAt);
    await syncSipLinesQuietly(tx, plan.client_id);
    return "MERGED";
  }
  if (current) {
    await setAuditReason(tx, reason?.trim() || "Replaced by newly approved plan");
    await tx`
      update public.advisory_plans set status = 'REPLACED', replaced_by_plan_id = ${planId}
      where id = ${current}`;
  }
  await setAuditReason(tx, reason?.trim() || "Plan approved");
  await tx`
    update public.advisory_plans set status = 'ACTIVE', approved_by = ${actor.id}, approved_at = ${approvedAt}
    where id = ${planId}`;
  // Parts the desk said were already done before onboarding: their calls and executions.
  const doneLines = await tx<{ id: string }[]>`
    select id from public.advisory_plan_items
    where plan_id = ${planId} and status = 'OPEN' and report_diff ? 'done_answer' and not report_diff ? 'done_call_id'`;
  for (const d of doneLines) await recordDoneBeforeOnboarding(tx, actor, d.id);
  // SIP starts / changes / stops the client already made since the report, shown in the CAS.
  await syncSipLinesQuietly(tx, plan.client_id);
  // Fresh money the plan invests counts in money left: a tranche with no plan to join,
  // or a new investor's first plan (no CAS yet, everything bought with new money).
  const m = meta[0];
  if (m?.fresh_money && Number(m.fresh_money) > 0) {
    await tx`
      insert into public.client_fresh_money (client_id, amount, received_on, plan_id, note, created_by)
      values (${plan.client_id}, ${m.fresh_money}, ${m.plan_date}::date, ${planId},
              ${`${m.plan_kind === "ADDITIONAL" ? "Additional investment" : "First investment"}: ${m.plan_name}`}, ${actor.id})`;
  }
  return "ACTIVE";
}

/** Lines of a plan that came from a merged additional-investment plan (item id -> tranche). */
export async function getTranches(tx: Tx, planId: string): Promise<Record<string, { plan_id: string; plan_name: string; plan_date: string }>> {
  const rows = await tx<{ id: string; plan_id: string; plan_name: string; plan_date: string }[]>`
    select i.id, t.id as plan_id, t.plan_name, t.plan_date::text
    from public.advisory_plan_items i join public.advisory_plans t on t.id = i.tranche_plan_id
    where i.plan_id = ${planId}`;
  return Object.fromEntries(rows.map((r) => [r.id, { plan_id: r.plan_id, plan_name: r.plan_name, plan_date: r.plan_date }]));
}

/**
 * Approve an ADDITIONAL plan (fresh money on top of the active plan): its lines
 * are added to the ACTIVE plan as a tranche (tranche_plan_id), the fresh money
 * is recorded, and the draft becomes MERGED. The active plan and its calls stay.
 */
async function mergeAdditionalPlan(
  tx: Tx,
  actor: Actor,
  p: { planId: string; activePlanId: string; clientId: string; plan_name: string; plan_date: string; fresh_money: number | null },
  reason: string | null | undefined,
  approvedAt: Date,
): Promise<void> {
  const blockers = await tx<{ n: number }[]>`
    select count(*)::int as n from (
      select id from public.advisory_plan_items
      where plan_id = ${p.planId} and status <> 'CANCELLED'
        and (needs_review or (action in ('SELL', 'BUY', 'SWITCH') and security_id is null))
      union all
      select id from public.sip_plan_items where plan_id = ${p.planId} and status <> 'CANCELLED' and needs_review
    ) x`;
  if (blockers[0].n > 0) throw new AppError(`Pick the fund for the ${blockers[0].n} line(s) marked "needs review" first.`);

  const why = reason?.trim() || `Tranche added: ${p.plan_name}${p.fresh_money ? ` (fresh money ₹${Number(p.fresh_money).toLocaleString("en-IN")})` : ""}`;
  await setAuditReason(tx, why);
  await tx`
    insert into public.advisory_plan_items
      (plan_id, client_id, security_id, scheme_name, folio_number, action, switch_to_security_id, target_amount, target_units,
       current_amount, target_weight, reason, priority, notes, status, needs_review, created_by, tranche_plan_id)
    select ${p.activePlanId}, client_id, security_id, scheme_name, folio_number, action, switch_to_security_id, target_amount, target_units,
           current_amount, target_weight, reason, priority + 10000, notes, 'OPEN', false, ${actor.id}, plan_id
    from public.advisory_plan_items
    where plan_id = ${p.planId} and status <> 'CANCELLED' and action <> 'RETAIN'`;
  await tx`
    insert into public.sip_plan_items
      (client_id, plan_id, security_id, scheme_name, folio_number, action, old_amount, new_amount, frequency, debit_day,
       status, notes, needs_review, created_by, tranche_plan_id)
    select client_id, ${p.activePlanId}, security_id, scheme_name, folio_number, action, old_amount, new_amount, frequency, debit_day,
           'PLANNED', notes, false, ${actor.id}, plan_id
    from public.sip_plan_items
    where plan_id = ${p.planId} and status <> 'CANCELLED'`;
  if (p.fresh_money && Number(p.fresh_money) > 0) {
    await tx`
      insert into public.client_fresh_money (client_id, amount, received_on, plan_id, note, created_by)
      values (${p.clientId}, ${p.fresh_money}, ${p.plan_date}::date, ${p.planId}, ${`Additional investment: ${p.plan_name}`}, ${actor.id})`;
  }
  await tx`
    update public.advisory_plans
    set notes = coalesce(notes || E'\n', '') || ${`Tranche added ${p.plan_date}: ${p.plan_name}${p.fresh_money ? ` · fresh money ₹${Number(p.fresh_money).toLocaleString("en-IN")}` : ""}`}
    where id = ${p.activePlanId}`;
  await tx`
    update public.advisory_plans
    set status = 'MERGED', merged_into_plan_id = ${p.activePlanId}, approved_by = ${actor.id}, approved_at = ${approvedAt}
    where id = ${p.planId}`;
}

export async function closePlan(tx: Tx, planId: string, status: "COMPLETED" | "CANCELLED", reason: string): Promise<void> {
  if (!reason.trim()) throw new AppError("A reason is required.");
  const plan = await assertPlanStatus(tx, planId, status === "CANCELLED" ? ["DRAFT", "ACTIVE"] : ["ACTIVE"]);
  await setAuditReason(tx, reason);
  if (plan.status === "ACTIVE" && status === "CANCELLED") {
    const open = await tx<{ n: number }[]>`
      select count(*)::int as n from public.v_advice_items v
      join public.advisory_plan_items pi on pi.id = v.plan_item_id
      where pi.plan_id = ${planId} and v.is_open`;
    if (open[0].n > 0) throw new AppError(`Cancel or complete the ${open[0].n} open call(s) of this plan first.`);
  }
  await tx`update public.advisory_plans set status = ${status}, notes = coalesce(notes || E'\n', '') || ${`${status}: ${reason}`} where id = ${planId}`;
}

// -----------------------------------------------------------------------------
// SIP items
// -----------------------------------------------------------------------------
export interface SipItemInput {
  security_id: string | null;
  scheme_name: string;
  folio_number?: string | null;
  action: "START" | "STOP" | "CHANGE";
  old_amount?: number | null;
  new_amount?: number | null;
  frequency?: string;
  debit_day?: number | null;
  notes?: string | null;
}

export async function addSipItem(tx: Tx, actor: Actor, planId: string, s: SipItemInput, reason?: string | null): Promise<string> {
  const plan = await assertPlanStatus(tx, planId, ["DRAFT", "ACTIVE"]);
  if (plan.status === "ACTIVE") {
    if (!reason?.trim()) throw new AppError("Adding a SIP item to an ACTIVE plan requires a reason.");
    await setAuditReason(tx, reason);
  }
  const rows = await tx<{ id: string }[]>`
    insert into public.sip_plan_items (client_id, plan_id, security_id, scheme_name, folio_number, action, old_amount,
                                       new_amount, frequency, debit_day, notes, created_by)
    values (${plan.client_id}, ${planId}, ${s.security_id}, ${s.scheme_name}, ${s.folio_number ?? null}, ${s.action},
            ${s.old_amount ?? null}, ${s.new_amount ?? null}, ${s.frequency ?? "MONTHLY"}, ${s.debit_day ?? null},
            ${s.notes ?? null}, ${actor.id})
    returning id`;
  return rows[0].id;
}

export async function deleteDraftSipItem(tx: Tx, sipId: string): Promise<void> {
  const res = await tx`
    delete from public.sip_plan_items s using public.advisory_plans p
    where s.id = ${sipId} and p.id = s.plan_id and p.status = 'DRAFT'`;
  if (res.count === 0) throw new AppError("Only SIP items of a DRAFT plan can be deleted.");
}

export async function setSipStatus(
  tx: Tx,
  sipId: string,
  status: "ADVISED" | "COMPLETED" | "CANCELLED",
  note?: string | null,
): Promise<void> {
  if (status === "CANCELLED" && !note?.trim()) throw new AppError("A reason is required to cancel a SIP action.");
  await setAuditReason(tx, note ?? `SIP action marked ${status}`);
  const res = await tx`
    update public.sip_plan_items set status = ${status},
      notes = case when ${note ?? null}::text is null then notes else coalesce(notes || E'\n', '') || ${note ?? ""} end
    where id = ${sipId}`;
  if (res.count === 0) throw new AppError("SIP item not found.", "NOT_FOUND");
}

// -----------------------------------------------------------------------------
// Advisory report extraction -> DRAFT plan (RULE 5: never auto-activated)
// -----------------------------------------------------------------------------
export async function ingestAdvisoryReport(
  tx: Tx,
  payload: AdvisoryReportResult,
  createdBy: string | null,
  opts: {
    extractionSource?: "AI_EXTRACTION" | "IMPORT";
    /** Securities already resolved by the caller, keyed by lower-cased scheme name. */
    securityIds?: Record<string, string>;
  } = {},
): Promise<{ planId: string | null; clientId: string; itemsNeedingReview: number; warnings: string[] }> {
  const client = await tx<{ id: string; created_by: string | null }[]>`
    select id, created_by from public.clients
    where (${payload.client_id ?? null}::uuid is not null and id = ${payload.client_id ?? null})
       or (${payload.client_code ?? null}::text is not null and client_code = ${payload.client_code ?? null})`;
  if (!client[0]) throw new AppError("Client not found for advisory report.", "NOT_FOUND");
  const clientId = client[0].id;

  if (payload.document_id) {
    await tx`
      update public.documents set parse_status = ${payload.status === "FAILED" ? "FAILED" : "NEEDS_REVIEW"},
             parse_error = ${payload.error ?? null}
      where id = ${payload.document_id} and client_id = ${clientId}`;
  }
  if (payload.status === "FAILED") return { planId: null, clientId, itemsNeedingReview: 0, warnings: [payload.error ?? "Extraction failed"] };

  if (payload.document_id) {
    const existing = await tx<{ id: string }[]>`
      select id from public.advisory_plans where source_document_id = ${payload.document_id} and status <> 'CANCELLED'`;
    if (existing[0]) return { planId: existing[0].id, clientId, itemsNeedingReview: 0, warnings: ["Draft already exists for this document."] };
  }

  const snapshot = await tx<{ id: string; total_current_value: number }[]>`
    select snapshot_id as id, total_current_value from public.v_latest_snapshot where client_id = ${clientId}`;

  const warnings = [...payload.warnings];
  const plan = await tx<{ id: string }[]>`
    insert into public.advisory_plans (client_id, plan_name, plan_date, notes, baseline_snapshot_id, starting_portfolio_value,
                                       source_document_id, extraction_source, extraction_payload, created_by, plan_kind, fresh_money)
    values (${clientId}, ${payload.plan.plan_name}, coalesce(${payload.plan.plan_date ?? null}::date, app.today_ist()),
            ${payload.plan.notes ?? null}, ${snapshot[0]?.id ?? null},
            ${payload.plan.starting_portfolio_value ?? snapshot[0]?.total_current_value ?? null},
            ${payload.document_id ?? null}, ${opts.extractionSource ?? "AI_EXTRACTION"}, ${tx.json(JSON.parse(JSON.stringify(payload)))}, ${createdBy},
            ${payload.plan.plan_kind ?? "FULL"}, ${payload.plan.fresh_money ?? null})
    returning id`;
  const planId = plan[0].id;

  const pool = await tx<SecurityCandidate[]>`
    select id, scheme_name, isin, plan_type, aliases from public.security_master where is_active`;
  let needsReview = 0;
  let priority = 10;
  const known = (name: string) => {
    const id = opts.securityIds?.[name.toLowerCase()];
    return id ? { id, confident: true } : null;
  };
  const itemRows = [];
  // Plan lines are Buy, Sell or Keep. A Migrate to Direct (Regular -> Direct of the same
  // fund) is a Sell of the Regular plan and a Buy of the Direct plan; a Switch is a Sell,
  // plus a Buy of the fund it goes to when the report names it.
  let migratedAmount = 0;
  let switchedInAmount = 0;
  for (const it of payload.items) {
    const sug = known(it.scheme_name) ?? (await suggestSecurity(tx, it.scheme_name, it.isin, pool));
    const flag = (!sug.confident && it.action !== "RETAIN") || Boolean(it.question);
    if (flag) needsReview++;
    const moves = it.action === "MIGRATE" || it.action === "SWITCH";
    const reason = it.action === "MIGRATE"
      ? migrateSellReason(it.reason)
      : it.reason ?? null;
    itemRows.push({
      switch_to_security_id: null,
      plan_id: planId, client_id: clientId, security_id: sug.id, scheme_name: it.scheme_name, folio_number: it.folio_number ?? null,
      action: moves ? "SELL" : it.action, target_amount: it.target_amount, target_units: it.target_units ?? null, current_amount: it.current_amount ?? null,
      target_weight: it.target_weight ?? null, reason, priority: it.priority ?? priority, needs_review: flag,
      notes: flag && !it.question ? "Security match needs confirmation (extracted from report)." : null, created_by: createdBy,
      report_question: it.question ?? null,
      report_diff: it.report_diff ? tx.json(it.report_diff) : null,
    });
    if (moves && it.switch_to_scheme_name && it.target_amount > 0) {
      // The Buy leg: the fund to move to (resolved by the caller, or a confident match).
      const to = known(it.switch_to_scheme_name) ?? (await suggestSecurity(tx, it.switch_to_scheme_name, null, pool));
      if (!to.confident) needsReview++;
      itemRows.push({
        switch_to_security_id: null,
        plan_id: planId, client_id: clientId, security_id: to.id, scheme_name: it.switch_to_scheme_name, folio_number: null,
        action: "BUY", target_amount: it.target_amount, target_units: null, current_amount: null, target_weight: null,
        reason: it.action === "MIGRATE" ? MIGRATE_BUY_REASON : switchBuyReason(it.scheme_name),
        priority: (it.priority ?? priority) + 1, needs_review: !to.confident,
        notes: to.confident ? null : "Security match needs confirmation (extracted from report).", created_by: createdBy,
        report_question: null,
        report_diff: null,
      });
      if (it.action === "MIGRATE") migratedAmount += it.target_amount;
      switchedInAmount += it.target_amount;
    } else if (it.action === "MIGRATE") {
      migratedAmount += it.target_amount;
    }
    priority += 10;
  }
  // One insert for all lines (the database may be far from the app server).
  if (itemRows.length) await tx`insert into public.advisory_plan_items ${tx(itemRows)}`;
  const sipRows = [];
  for (const s of payload.sip_items) {
    const sug = known(s.scheme_name) ?? (await suggestSecurity(tx, s.scheme_name, s.isin, pool));
    const flag = !sug.confident;
    if (flag) needsReview++;
    sipRows.push({
      client_id: clientId, plan_id: planId, security_id: sug.id, scheme_name: s.scheme_name, folio_number: s.folio_number ?? null,
      action: s.action, old_amount: s.old_amount ?? null, new_amount: s.new_amount ?? null, frequency: s.frequency,
      debit_day: s.debit_day ?? null, notes: s.notes ?? null, needs_review: flag, created_by: createdBy,
    });
  }
  if (sipRows.length) await tx`insert into public.sip_plan_items ${tx(sipRows)}`;

  // Cross-check declared totals from the report against extracted line items.
  const t = await tx<{ target_exit_value: number; target_buy_value: number; target_sip_value: number }[]>`
    select target_exit_value, target_buy_value, target_sip_value from public.advisory_plans where id = ${planId}`;
  const d = payload.declared_totals;
  const check = (label: string, declared: number | null | undefined, actual: number) => {
    if (declared != null && Math.abs(declared - actual) > Math.max(1, declared * 0.005)) {
      warnings.push(`${label}: report says ₹${Math.round(declared).toLocaleString("en-IN")}, items add up to ₹${Math.round(actual).toLocaleString("en-IN")}.`);
    }
  };
  // The report's totals leave out migrations (and switch-ins), which are now Sell / Buy lines.
  check("Total exit", d?.exit_value == null ? null : d.exit_value + migratedAmount, t[0].target_exit_value);
  check("Total buy", d?.buy_value == null ? null : d.buy_value + switchedInAmount, t[0].target_buy_value);
  check("Total SIP", d?.sip_value, t[0].target_sip_value);

  if (warnings.length) {
    await tx`update public.advisory_plans set notes = coalesce(notes || E'\n\n', '') || ${`Extraction warnings:\n- ${warnings.join("\n- ")}`} where id = ${planId}`;
  }
  return { planId, clientId, itemsNeedingReview: needsReview, warnings };
}

// -----------------------------------------------------------------------------
// Questions from the report: wording that could not be read as Buy / Sell / Keep
// -----------------------------------------------------------------------------
export interface ReportQuestionRow {
  id: string;
  plan_id: string;
  scheme_name: string;
  folio_number: string | null;
  security_id: string | null;
  current_amount: number | null;
  reason: string | null;
  report_question: string;
  report_answer: string | null;
  action: string;
  target_amount: number;
  open: boolean;
  /** Report vs a newer CAS: what differs and what was done since (prefills the answer). */
  report_diff: (ReportDiff & { done_answer?: { amount: number; date: string }; done_call_id?: string }) | null;
}

export async function listReportQuestions(tx: Tx, planId: string): Promise<ReportQuestionRow[]> {
  return tx<ReportQuestionRow[]>`
    select id, plan_id, scheme_name, folio_number, security_id, current_amount::float8 as current_amount, reason,
           report_question, report_answer, action, target_amount::float8 as target_amount, report_diff,
           (report_answer is null and status = 'OPEN') as open
    from public.advisory_plan_items
    where plan_id = ${planId} and report_question is not null and status <> 'CANCELLED'
    order by (report_answer is null) desc, priority, scheme_name`;
}

/** Open report questions on a client's DRAFT / ACTIVE plans (for alerts). */
export async function countOpenReportQuestions(tx: Tx, clientId: string): Promise<{ planId: string; n: number } | null> {
  const r = (await tx<{ plan_id: string; n: number }[]>`
    select pi.plan_id, count(*)::int as n
    from public.advisory_plan_items pi join public.advisory_plans p on p.id = pi.plan_id and p.status in ('DRAFT', 'ACTIVE')
    where pi.client_id = ${clientId} and pi.report_question is not null and pi.report_answer is null and pi.status = 'OPEN'
    group by pi.plan_id, p.status order by (p.status = 'ACTIVE') desc limit 1`)[0];
  return r ? { planId: r.plan_id, n: r.n } : null;
}

export interface ReportAnswer {
  action: "SELL" | "BUY" | "RETAIN";
  /** Rupees; or percent of the holding for a Sell. */
  amount?: number | null;
  percent?: number | null;
  explanation: string;
  /**
   * Part already done before onboarding (seen in a CAS newer than the report):
   * recorded as a call + execution on this line once the plan is active.
   */
  done?: { amount: number; date: string } | null;
}

/**
 * The desk explains a recommendation the reader could not place (or a
 * difference between the report and a newer CAS): the line becomes a Buy, Sell
 * or Keep with the explanation kept on it; a part already done is recorded as
 * a call and its execution (now on an ACTIVE plan, else when the plan is
 * approved). On an ACTIVE plan the explanation is the audit reason.
 */
export async function answerReportQuestion(tx: Tx, actor: Actor, itemId: string, a: ReportAnswer): Promise<void> {
  if (actor.role === "OPERATIONS") throw new AppError("Only an advisor or admin can answer a question on the plan.", "FORBIDDEN");
  const explanation = a.explanation.trim();
  if (!explanation) throw new AppError("Explain what the report means for this fund.");
  const it = (await tx<{ plan_id: string; scheme_name: string; security_id: string | null; current_amount: number | null; report_question: string | null; reason: string | null; status: string }[]>`
    select plan_id, scheme_name, security_id, current_amount::float8 as current_amount, report_question, reason, status
    from public.advisory_plan_items where id = ${itemId} for update`)[0];
  if (!it || !it.report_question) throw new AppError("Question not found.", "NOT_FOUND");
  if (it.status !== "OPEN") throw new AppError("This plan line is closed.");
  const plan = await assertPlanStatus(tx, it.plan_id, ["DRAFT", "ACTIVE"]);
  const done = a.done && Number(a.done.amount) > 0 ? { amount: Math.round(Number(a.done.amount) * 100) / 100, date: a.done.date } : null;
  if (done) {
    if (a.action === "RETAIN") throw new AppError("A Keep has nothing done on our advice: choose Sell or Buy, or clear the amount already done.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(done.date)) throw new AppError("Enter the date it was done.");
    const today = (await tx<{ d: string }[]>`select app.today_ist()::text as d`)[0].d;
    if (done.date > today) throw new AppError("The date it was done cannot be in the future.");
  }
  let target = 0;
  if (a.action !== "RETAIN") {
    const pct = Number(a.percent) > 0 ? Number(a.percent) : null;
    if (pct && a.action === "SELL") {
      if (pct > 100) throw new AppError("A percentage cannot be over 100.");
      if (!(Number(it.current_amount) > 0)) throw new AppError("The holding's value is not known: enter the amount in rupees.");
      target = Math.round(Number(it.current_amount) * pct) / 100;
    } else {
      target = Number(a.amount) > 0 ? Number(a.amount) : done?.amount ?? 0;
    }
    if (!(target > 0)) throw new AppError(`Enter the amount to ${a.action === "SELL" ? "sell (₹ or % of the holding)" : "buy"}.`);
    // What is still to sell must be held now (the part already done is no longer in the CAS).
    if (a.action === "SELL" && Number(it.current_amount) > 0 && target - (done?.amount ?? 0) > Number(it.current_amount) * 1.02) {
      throw new AppError("That is more than the client holds in this fund.");
    }
    if (done && done.amount > target * 1.02 + 1) throw new AppError("The part already done is more than the line's amount.");
    if (!it.security_id) throw new AppError("Pick the fund for this line first (Edit on the plan line).");
  }
  await setAuditReason(tx, `Report question answered: ${explanation}`.slice(0, 500));
  const what = a.action === "RETAIN" ? "Keep" : `${a.action === "SELL" ? "Sell" : "Buy"} ₹${target.toLocaleString("en-IN")}${a.percent && a.action === "SELL" ? ` (${a.percent}%)` : ""}`
    + (done ? `, ₹${done.amount.toLocaleString("en-IN")} done on ${done.date}` : "");
  await tx`
    update public.advisory_plan_items set
      action = ${a.action}, target_amount = ${target}, report_answer = ${explanation.slice(0, 2000)},
      reason = ${`${it.reason ?? "Report"} → ${what}: ${explanation}`.slice(0, 4000)},
      needs_review = (security_id is null and ${a.action} <> 'RETAIN'),
      report_diff = case when ${done ? tx.json(done) : null}::jsonb is null then report_diff
                         else coalesce(report_diff, '{}'::jsonb) || jsonb_build_object('done_answer', ${done ? tx.json(done) : null}::jsonb) end
    where id = ${itemId}`;
  if (done && plan.status === "ACTIVE") await recordDoneBeforeOnboarding(tx, actor, itemId);
}

/**
 * A part already done before onboarding (answered on a report question): one
 * call and its execution on the line, dated when it was done, proved by the
 * client's onboarding CAS. Runs once per line (the call id is kept in report_diff).
 */
export async function recordDoneBeforeOnboarding(tx: Tx, actor: Actor, itemId: string): Promise<string | null> {
  const it = (await tx<{ client_id: string; security_id: string; scheme_name: string; action: string; report_diff: { done_answer?: { amount: number; date: string }; done_call_id?: string } | null }[]>`
    select client_id, security_id, scheme_name, action, report_diff from public.advisory_plan_items where id = ${itemId}`)[0];
  const done = it?.report_diff?.done_answer;
  if (!it || !done || it.report_diff?.done_call_id || (it.action !== "SELL" && it.action !== "BUY")) return null;
  // The CAS this plan was built from (the newer CAS that shows the trade); else the client's first CAS.
  const proof = (await tx<{ document_id: string | null; snapshot_date: string }[]>`
    select d.document_id, s.snapshot_date::text as snapshot_date from public.portfolio_snapshots s
    left join public.cas_documents d on d.id = s.cas_document_id
    where s.client_id = ${it.client_id}
      and (s.id = (select p.baseline_snapshot_id from public.advisory_plans p join public.advisory_plan_items i on i.plan_id = p.id where i.id = ${itemId})
           or s.is_baseline)
    order by (s.id = (select p.baseline_snapshot_id from public.advisory_plans p join public.advisory_plan_items i on i.plan_id = p.id where i.id = ${itemId})) desc nulls last
    limit 1`)[0];
  const b = await issueAdvice(tx, actor, {
    clientId: it.client_id,
    communicatedAt: new Date(`${done.date}T09:00:00+05:30`),
    channel: "OTHER",
    notes: `Done before onboarding: seen in the client's CAS${proof ? ` of ${proof.snapshot_date}` : ""}`,
    items: [{ plan_item_id: itemId, security_id: it.security_id, scheme_name: it.scheme_name, action: it.action as "SELL" | "BUY", quantity_basis: "AMOUNT", advised_amount: done.amount }],
  });
  await recordExecution(tx, actor, {
    adviceItemId: b.itemIds[0], executionDate: done.date, executedAmount: done.amount, executedUnits: null,
    verificationType: "PROOF_VERIFIED", proofDocumentId: proof?.document_id ?? null,
    notes: `Done before onboarding; shown in the client's CAS${proof ? ` of ${proof.snapshot_date}` : ""}`,
  });
  await setAuditReason(tx, "Done before onboarding: call recorded on the plan line");
  await tx`update public.advisory_plan_items set report_diff = report_diff || jsonb_build_object('done_call_id', ${b.itemIds[0]}::text) where id = ${itemId}`;
  return b.itemIds[0];
}
