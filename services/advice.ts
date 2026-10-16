import type { Actor, Tx } from "@/lib/db/tx";
import { setAuditReason } from "@/lib/db/tx";
import { AppError } from "@/lib/errors";
import { revisionRemainder } from "@/lib/domain/advice-rules";
import type { AdviceItemView, Channel, ExecutionRow } from "@/types/domain";

export interface IssueAdviceItemInput {
  plan_item_id?: string | null;
  security_id: string;
  scheme_name?: string | null;
  folio_number?: string | null;
  action: "BUY" | "SELL" | "SWITCH";
  quantity_basis: "AMOUNT" | "UNITS";
  advised_amount: number;
  advised_units?: number | null;
  reference_price?: number | null;
  valid_until?: string | null;
}

export interface IssueAdviceInput {
  clientId: string;
  advisorId?: string | null;
  communicatedAt: Date;
  channel: Channel;
  notes?: string | null;
  items: IssueAdviceItemInput[];
}

/**
 * Record a communication with the client (one batch, many items). Atomic: all
 * items are created or none. Timestamps are immutable afterwards.
 */
export async function issueAdvice(tx: Tx, actor: Actor, input: IssueAdviceInput): Promise<{ batchId: string; batchCode: string; itemIds: string[] }> {
  if (input.items.length === 0) throw new AppError("Add at least one call.");
  if (input.communicatedAt.getTime() > Date.now() + 5 * 60_000) throw new AppError("The communication time cannot be in the future.");
  const advisorId = actor.role === "ADMIN" ? input.advisorId || actor.id : actor.id;

  const activePlan = await tx<{ id: string }[]>`
    select id from public.advisory_plans where client_id = ${input.clientId} and status = 'ACTIVE'`;

  const batch = await tx<{ id: string; batch_code: string }[]>`
    insert into public.advice_batches (client_id, advisor_id, plan_id, communicated_at, communication_channel, notes, created_by)
    values (${input.clientId}, ${advisorId}, ${activePlan[0]?.id ?? null}, ${input.communicatedAt}, ${input.channel},
            ${input.notes ?? null}, ${actor.id})
    returning id, batch_code`;

  const itemIds: string[] = [];
  for (const it of input.items) {
    if (!(it.advised_amount > 0)) throw new AppError("Every call needs an advised amount (estimate for unit-based calls).");
    if (it.quantity_basis === "UNITS" && !(Number(it.advised_units) > 0)) throw new AppError("Unit-based calls need advised units.");
    const sec = await tx<{ scheme_name: string }[]>`select scheme_name from public.security_master where id = ${it.security_id}`;
    if (!sec[0]) throw new AppError("Unknown security selected.");
    // Every call sits on a Buy or Sell line of the active plan (added when the plan has none for this fund).
    const planItemId = it.plan_item_id || (activePlan[0]
      ? await ensurePlanLine(tx, { clientId: input.clientId, securityId: it.security_id, schemeName: it.scheme_name || sec[0].scheme_name, action: it.action, amount: it.advised_amount, why: input.notes })
      : null);
    const rows = await tx<{ id: string }[]>`
      insert into public.advice_items (advice_batch_id, client_id, plan_item_id, security_id, scheme_name, folio_number, action,
                                       quantity_basis, advised_amount, advised_units, reference_price, valid_until, created_by)
      values (${batch[0].id}, ${input.clientId}, ${planItemId}, ${it.security_id}, ${it.scheme_name || sec[0].scheme_name},
              ${it.folio_number || null}, ${it.action}, ${it.quantity_basis}, ${it.advised_amount}, ${it.advised_units || null},
              ${it.reference_price || null}, ${it.valid_until || null}, ${actor.id})
      returning id`;
    itemIds.push(rows[0].id);
    await syncOutsideLine(tx, planItemId);
  }
  return { batchId: batch[0].id, batchCode: batch[0].batch_code, itemIds };
}

/**
 * The open line of the client's ACTIVE plan that a call on this fund belongs to,
 * or null: a sell goes to a Sell line, a buy to a Buy line (plan lines are
 * Buy, Sell or Keep only).
 */
export async function findPlanLine(tx: Tx, clientId: string, securityId: string, action: "BUY" | "SELL" | "SWITCH"): Promise<string | null> {
  const row = (await tx<{ id: string }[]>`
    select pi.id
    from public.advisory_plan_items pi
    join public.advisory_plans p on p.id = pi.plan_id and p.status = 'ACTIVE'
    left join public.v_plan_item_progress v on v.plan_item_id = pi.id
    where pi.client_id = ${clientId} and pi.security_id = ${securityId} and pi.status = 'OPEN'
      and case when ${action} = 'BUY' then pi.action = 'BUY' else pi.action in ('SELL', 'SWITCH') end
    order by coalesce(v.yet_to_advise_amount, pi.target_amount) desc, pi.created_at
    limit 1`)[0];
  return row?.id ?? null;
}

/**
 * Admin repair: put a client's calls that sit outside the plan on the plan
 * line of their fund (see ensurePlanLine: an existing Buy / Sell line, a Keep
 * line turned Sell, or a new line). Audited.
 */
/** Lines added or changed because a call was given for a fund the plan did not cover. */
export const OUTSIDE_REPORT = "Advised outside the report";

/**
 * The Buy / Sell line of the client's ACTIVE plan for this call, so every call
 * is tracked against Buy, Sell or Keep and nothing floats outside the plan:
 *  - the open Sell (sell / switch) or Buy line of the same fund;
 *  - else, for a sell, the fund's Keep line becomes a Sell of this amount (an
 *    open question on it is answered by the call);
 *  - else a new line of this amount is added.
 * A line made this way follows its calls (syncOutsideLine). Audited; returns
 * null when the client has no ACTIVE plan.
 */
export async function ensurePlanLine(
  tx: Tx,
  a: { clientId: string; securityId: string; schemeName: string; action: "BUY" | "SELL" | "SWITCH"; amount: number; why?: string | null },
): Promise<string | null> {
  // The caller's audit reason is put back afterwards (this only changes it for the plan line).
  const prev = (await tx<{ r: string | null }[]>`select current_setting('app.audit_reason', true) as r`)[0]?.r ?? null;
  try {
    return await placeCall(tx, a);
  } finally {
    await setAuditReason(tx, prev);
  }
}

async function placeCall(
  tx: Tx,
  a: { clientId: string; securityId: string; schemeName: string; action: "BUY" | "SELL" | "SWITCH"; amount: number; why?: string | null },
): Promise<string | null> {
  const plan = (await tx<{ id: string }[]>`select id from public.advisory_plans where client_id = ${a.clientId} and status = 'ACTIVE'`)[0];
  if (!plan) return null;
  const amount = Math.round(a.amount * 100) / 100;
  const label = `${OUTSIDE_REPORT}${a.why ? ` (${a.why.slice(0, 120)})` : ""}`;
  const found = await findPlanLine(tx, a.clientId, a.securityId, a.action);
  if (found) return found;
  if (a.action !== "BUY") {
    const keep = (await tx<{ id: string; report_question: string | null; reason: string | null }[]>`
      select id, report_question, reason from public.advisory_plan_items
      where plan_id = ${plan.id} and security_id = ${a.securityId} and action = 'RETAIN' and status = 'OPEN'
      order by current_amount desc nulls last limit 1`)[0];
    if (keep) {
      await setAuditReason(tx, `${OUTSIDE_REPORT}: Keep line became a Sell of ₹${amount.toLocaleString("en-IN")}`);
      await tx`
        update public.advisory_plan_items set
          action = 'SELL', target_amount = ${amount}, needs_review = false,
          reason = ${`${OUTSIDE_REPORT}: sold ₹${amount.toLocaleString("en-IN")} (the report said: ${(keep.reason ?? "keep").slice(0, 200)})`},
          report_answer = case when report_question is not null and report_answer is null
                               then ${`Sold ₹${amount.toLocaleString("en-IN")} on advice`} else report_answer end
        where id = ${keep.id}`;
      return keep.id;
    }
  }
  await setAuditReason(tx, `${OUTSIDE_REPORT}: ${a.action === "BUY" ? "Buy" : "Sell"} line added for a call`);
  const ins = await tx<{ id: string }[]>`
    insert into public.advisory_plan_items (plan_id, security_id, scheme_name, action, target_amount, reason, priority, status)
    values (${plan.id}, ${a.securityId}, ${a.schemeName}, ${a.action === "BUY" ? "BUY" : "SELL"}, ${amount}, ${label}, 9000, 'OPEN')
    returning id`;
  return ins[0].id;
}

/**
 * A line that exists only because of calls outside the report keeps its target
 * equal to what those calls advise (after revisions, cancellations and
 * corrections). With nothing advised any more, a Keep line turned Sell goes back
 * to Keep (its report question re-opens) and an added line is cancelled.
 */
export async function syncOutsideLine(tx: Tx, planItemId: string | null | undefined): Promise<void> {
  if (!planItemId) return;
  const line = (await tx<{ reason: string | null; target_amount: number; status: string; report_answer: string | null }[]>`
    select reason, target_amount::float8 as target_amount, status, report_answer from public.advisory_plan_items where id = ${planItemId}`)[0];
  if (!line?.reason?.startsWith(OUTSIDE_REPORT) || line.status === "CANCELLED") return;
  const total = Math.round(Number((await tx<{ t: number }[]>`
    select coalesce(sum(effective_advised_amount), 0)::float8 as t from public.v_advice_items where plan_item_id = ${planItemId}`)[0].t) * 100) / 100;
  if (Math.abs(total - line.target_amount) < 0.01) return;
  const prev = (await tx<{ r: string | null }[]>`select current_setting('app.audit_reason', true) as r`)[0]?.r ?? null;
  try {
    if (total > 0) {
      await setAuditReason(tx, `${OUTSIDE_REPORT}: target follows the calls on this line`);
      await tx`update public.advisory_plan_items set target_amount = ${total} where id = ${planItemId}`;
      return;
    }
    const kept = /\(the report said: ([\s\S]*)\)$/.exec(line.reason)?.[1];
    if (line.reason.startsWith(`${OUTSIDE_REPORT}: sold`) && kept !== undefined) {
      await setAuditReason(tx, `${OUTSIDE_REPORT}: no call left on it, back to Keep`);
      await tx`
        update public.advisory_plan_items set action = 'RETAIN', target_amount = 0, reason = ${kept},
          report_answer = case when report_answer like 'Sold ₹% on advice' then null else report_answer end,
          needs_review = (report_question is not null and (report_answer is null or report_answer like 'Sold ₹% on advice'))
        where id = ${planItemId}`;
    } else {
      await setAuditReason(tx, `${OUTSIDE_REPORT}: no call left on it`);
      await tx`update public.advisory_plan_items set status = 'CANCELLED' where id = ${planItemId}`;
    }
  } finally {
    await setAuditReason(tx, prev);
  }
}

export async function linkCallsToPlan(tx: Tx, actor: Actor, clientId: string): Promise<{ linked: number; left: number }> {
  if (actor.role !== "ADMIN") throw new AppError("Only an admin can re-link recorded calls.", "FORBIDDEN");
  const calls = await tx<{ id: string; security_id: string; scheme_name: string; action: "BUY" | "SELL" | "SWITCH"; advised_amount: number }[]>`
    select ai.id, ai.security_id, ai.scheme_name, ai.action, ai.advised_amount::float8 as advised_amount
    from public.advice_items ai join public.advice_batches b on b.id = ai.advice_batch_id
    where ai.client_id = ${clientId} and ai.plan_item_id is null and b.status = 'ACTIVE'
      and ai.status not in ('CANCELLED', 'REVISED')
      -- Only calls given under the current plan: older plans' calls belong to their own plan.
      and b.plan_id = (select id from public.advisory_plans where client_id = ${clientId} and status = 'ACTIVE')
    order by ai.created_at`;
  if (!calls.length) return { linked: 0, left: 0 };
  let linked = 0;
  for (const c of calls) {
    const line = await ensurePlanLine(tx, { clientId, securityId: c.security_id, schemeName: c.scheme_name, action: c.action, amount: c.advised_amount, why: "linked later" });
    if (!line) continue;
    await setAuditReason(tx, "Admin correction: link a call outside the plan to the plan line of its fund");
    await tx`update public.advice_items set plan_item_id = ${line} where id = ${c.id}`;
    await syncOutsideLine(tx, line);
    linked += 1;
  }
  return { linked, left: calls.length - linked };
}

export async function getAdviceItem(tx: Tx, id: string): Promise<AdviceItemView> {
  const rows = await tx<AdviceItemView[]>`
    select v.*, c.client_code, c.full_name as client_name, pr.full_name as advisor_name,
           t.first_execution_date::text as first_execution_date, t.lag_days, t.completion_lag_days,
           coalesce(t.cas_verified, false) as cas_verified
    from public.v_advice_items v
    join public.clients c on c.id = v.client_id
    left join public.profiles pr on pr.id = v.advisor_id
    left join public.v_advice_execution_timing t on t.advice_item_id = v.id
    where v.id = ${id}`;
  if (!rows[0]) throw new AppError("Advice item not found.", "NOT_FOUND");
  return rows[0];
}

/** Full revision chain (oldest first) that contains this item. */
export async function getRevisionChain(tx: Tx, id: string): Promise<AdviceItemView[]> {
  return tx<AdviceItemView[]>`
    with recursive up as (
      select id, revises_advice_item_id from public.advice_items where id = ${id}
      union all
      select a.id, a.revises_advice_item_id from public.advice_items a join up on a.id = up.revises_advice_item_id
    ),
    root as (select id from up where revises_advice_item_id is null),
    down as (
      select a.id from public.advice_items a where a.id = (select id from root)
      union all
      select a.id from public.advice_items a join down on a.revises_advice_item_id = down.id
    )
    select v.* from public.v_advice_items v where v.id in (select id from down)
    order by v.created_at`;
}

export async function getExecutionsForAdvice(tx: Tx, adviceItemId: string): Promise<ExecutionRow[]> {
  return tx<ExecutionRow[]>`
    select e.*, pr.full_name as created_by_name
    from public.executions e left join public.profiles pr on pr.id = e.created_by
    where e.advice_item_id = ${adviceItemId}
    order by e.execution_date, e.created_at`;
}

export interface ReviseInput {
  adviceItemId: string;
  newTotalAmount: number;
  newTotalUnits?: number | null;
  referencePrice?: number | null;
  reason: string;
  communicatedAt: Date;
  channel: Channel;
}

/**
 * Revise a call: the original becomes REVISED (kept forever) and a new item is
 * issued in a new batch for the remainder (new total minus already executed).
 */
export async function reviseAdvice(tx: Tx, actor: Actor, input: ReviseInput): Promise<{ newItemId: string; batchCode: string }> {
  if (!input.reason.trim()) throw new AppError("A reason is required to revise a call.");
  const orig = await getAdviceItem(tx, input.adviceItemId);
  if (!orig.is_open) throw new AppError(`Only open calls can be revised (this one is ${orig.status}).`);

  let remainder: { amount: number; units: number | null };
  try {
    remainder = revisionRemainder(
      {
        quantityBasis: orig.quantity_basis,
        advisedAmount: orig.advised_amount,
        advisedUnits: orig.advised_units,
        executedAmount: orig.executed_amount,
        executedUnits: orig.executed_units,
      },
      { amount: input.newTotalAmount, units: input.newTotalUnits },
    );
  } catch (e) {
    throw new AppError((e as Error).message);
  }

  await setAuditReason(tx, input.reason);
  await tx`
    update public.advice_items set status = 'REVISED', status_reason = ${input.reason}
    where id = ${orig.id}`;
  await dropPendingMatches(tx, orig.id, "The call was revised: re-check the CAS against the new call");

  const batch = await tx<{ id: string; batch_code: string }[]>`
    insert into public.advice_batches (client_id, advisor_id, plan_id, communicated_at, communication_channel, notes, created_by)
    values (${orig.client_id}, ${actor.role === "ADMIN" ? orig.advisor_id : actor.id},
            (select plan_id from public.advice_batches where id = ${orig.advice_batch_id}),
            ${input.communicatedAt}, ${input.channel}, ${`Revision of ${orig.batch_code}: ${input.reason}`}, ${actor.id})
    returning id, batch_code`;

  const item = await tx<{ id: string }[]>`
    insert into public.advice_items (advice_batch_id, client_id, plan_item_id, security_id, scheme_name, folio_number, action,
                                     quantity_basis, advised_amount, advised_units, reference_price, valid_until,
                                     revises_advice_item_id, created_by)
    values (${batch[0].id}, ${orig.client_id}, ${orig.plan_item_id}, ${orig.security_id}, ${orig.scheme_name},
            ${orig.folio_number}, ${orig.action}, ${orig.quantity_basis}, ${remainder.amount}, ${remainder.units},
            ${input.referencePrice ?? orig.reference_price}, ${orig.valid_until}, ${orig.id}, ${actor.id})
    returning id`;
  await syncOutsideLine(tx, orig.plan_item_id);
  return { newItemId: item[0].id, batchCode: batch[0].batch_code };
}

/** Cancel (or expire) the remaining part of a call. Executions already recorded stay counted. */
export async function closeAdvice(tx: Tx, adviceItemId: string, status: "CANCELLED" | "EXPIRED", reason: string): Promise<void> {
  if (!reason.trim()) throw new AppError("A reason is required.");
  const item = await getAdviceItem(tx, adviceItemId);
  if (!item.is_open) throw new AppError(`Call is already ${item.status}.`);
  await setAuditReason(tx, reason);
  const res = await tx`update public.advice_items set status = ${status}, status_reason = ${reason} where id = ${adviceItemId}`;
  if (res.count === 0) throw new AppError("This call cannot be closed with your access.", "FORBIDDEN");
  await dropPendingMatches(tx, adviceItemId, `The call was ${status.toLowerCase()}`);
  await syncOutsideLine(tx, item.plan_item_id);
}

/**
 * CAS matches still waiting for a decision on a call that is closed or revised can no longer be
 * confirmed: they are turned down (with the reason), and a run left with nothing to decide closes.
 */
async function dropPendingMatches(tx: Tx, adviceItemId: string, why: string): Promise<void> {
  const runs = await tx<{ run_id: string }[]>`
    update public.reconciliation_matches set status = 'REJECTED', resolution_note = ${why}, resolved_at = now()
    where advice_item_id = ${adviceItemId} and status = 'SUGGESTED'
    returning run_id`;
  for (const runId of new Set(runs.map((r) => r.run_id))) {
    await tx`
      update public.reconciliation_runs r set status = 'COMPLETED', completed_at = now()
      where r.id = ${runId} and r.status = 'OPEN'
        and not exists (
          select 1 from public.reconciliation_matches x
          where x.run_id = r.id and (x.status = 'SUGGESTED' or (x.status = 'UNEXPLAINED' and x.reviewed_at is null)))`;
  }
}

// -----------------------------------------------------------------------------
// Ledger
// -----------------------------------------------------------------------------
export interface LedgerFilters {
  from?: string | null; // YYYY-MM-DD (IST)
  to?: string | null;
  advisorId?: string | null;
  clientId?: string | null;
  side?: "BUY" | "SELL" | null;
  status?: "PENDING" | "PARTIAL" | "EXECUTED" | "CANCELLED" | "OPEN" | null;
  limit?: number;
}

export async function listAdviceLedger(tx: Tx, f: LedgerFilters = {}): Promise<AdviceItemView[]> {
  const statusList =
    f.status === "PENDING" ? ["ISSUED"]
    : f.status === "PARTIAL" ? ["PARTIALLY_EXECUTED"]
    : f.status === "EXECUTED" ? ["EXECUTED"]
    : f.status === "CANCELLED" ? ["CANCELLED", "EXPIRED", "REVISED"]
    : f.status === "OPEN" ? ["ISSUED", "PARTIALLY_EXECUTED"]
    : null;
  return tx<AdviceItemView[]>`
    select v.*, c.client_code, c.full_name as client_name, pr.full_name as advisor_name,
           t.first_execution_date::text as first_execution_date, t.lag_days, t.completion_lag_days,
           coalesce(t.cas_verified, false) as cas_verified
    from public.v_advice_items v
    join public.clients c on c.id = v.client_id
    left join public.profiles pr on pr.id = v.advisor_id
    left join public.v_advice_execution_timing t on t.advice_item_id = v.id
    where (${f.from ?? null}::date is null or (v.communicated_at at time zone 'Asia/Kolkata')::date >= ${f.from ?? null}::date)
      and (${f.to ?? null}::date is null or (v.communicated_at at time zone 'Asia/Kolkata')::date <= ${f.to ?? null}::date)
      and (${f.advisorId ?? null}::uuid is null or v.advisor_id = ${f.advisorId ?? null})
      and (${f.clientId ?? null}::uuid is null or v.client_id = ${f.clientId ?? null})
      and (${f.side ?? null}::text is null
           or (${f.side ?? null} = 'BUY' and v.action = 'BUY')
           or (${f.side ?? null} = 'SELL' and v.action in ('SELL', 'SWITCH')))
      and (${statusList}::text[] is null or v.status = any(${statusList}::text[]))
    order by v.communicated_at desc, v.created_at desc
    limit ${f.limit ?? 500}`;
}
