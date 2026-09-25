import type { Actor, Tx } from "@/lib/db/tx";
import { setAuditReason } from "@/lib/db/tx";
import { AppError } from "@/lib/errors";
import type { AdvisoryReportResult } from "@/lib/integrations/contracts";
import type { PlanItemProgress, PlanRow, PlanTransition, SipItem } from "@/types/domain";
import { suggestSecurity } from "./securities";
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
  action: "SELL" | "BUY" | "RETAIN" | "SWITCH";
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
      needs_review = case when ${item.security_id}::uuid is null then needs_review else false end
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
): Promise<void> {
  const plan = await assertPlanStatus(tx, planId, ["DRAFT"]);
  const items = await tx<{ n: number }[]>`
    select count(*)::int as n from public.advisory_plan_items where plan_id = ${planId} and status <> 'CANCELLED'`;
  const sips = await tx<{ n: number }[]>`select count(*)::int as n from public.sip_plan_items where plan_id = ${planId}`;
  if (items[0].n + sips[0].n === 0) throw new AppError("A plan needs at least one item before approval.");

  const current = await getActivePlanId(tx, plan.client_id);
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
                                       source_document_id, extraction_source, extraction_payload, created_by)
    values (${clientId}, ${payload.plan.plan_name}, coalesce(${payload.plan.plan_date ?? null}::date, app.today_ist()),
            ${payload.plan.notes ?? null}, ${snapshot[0]?.id ?? null},
            ${payload.plan.starting_portfolio_value ?? snapshot[0]?.total_current_value ?? null},
            ${payload.document_id ?? null}, ${opts.extractionSource ?? "AI_EXTRACTION"}, ${tx.json(JSON.parse(JSON.stringify(payload)))}, ${createdBy})
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
  for (const it of payload.items) {
    const sug = known(it.scheme_name) ?? (await suggestSecurity(tx, it.scheme_name, it.isin, pool));
    const flag = !sug.confident && it.action !== "RETAIN";
    if (flag) needsReview++;
    itemRows.push({
      plan_id: planId, client_id: clientId, security_id: sug.id, scheme_name: it.scheme_name, folio_number: it.folio_number ?? null,
      action: it.action, target_amount: it.target_amount, target_units: it.target_units ?? null, current_amount: it.current_amount ?? null,
      target_weight: it.target_weight ?? null, reason: it.reason ?? null, priority: it.priority ?? priority, needs_review: flag,
      notes: flag ? "Security match needs confirmation (extracted from report)." : null, created_by: createdBy,
    });
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
  check("Total exit", d?.exit_value, t[0].target_exit_value);
  check("Total buy", d?.buy_value, t[0].target_buy_value);
  check("Total SIP", d?.sip_value, t[0].target_sip_value);

  if (warnings.length) {
    await tx`update public.advisory_plans set notes = coalesce(notes || E'\n\n', '') || ${`Extraction warnings:\n- ${warnings.join("\n- ")}`} where id = ${planId}`;
  }
  return { planId, clientId, itemsNeedingReview: needsReview, warnings };
}
