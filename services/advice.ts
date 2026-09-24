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
    const rows = await tx<{ id: string }[]>`
      insert into public.advice_items (advice_batch_id, client_id, plan_item_id, security_id, scheme_name, folio_number, action,
                                       quantity_basis, advised_amount, advised_units, reference_price, valid_until, created_by)
      values (${batch[0].id}, ${input.clientId}, ${it.plan_item_id || null}, ${it.security_id}, ${it.scheme_name || sec[0].scheme_name},
              ${it.folio_number || null}, ${it.action}, ${it.quantity_basis}, ${it.advised_amount}, ${it.advised_units || null},
              ${it.reference_price || null}, ${it.valid_until || null}, ${actor.id})
      returning id`;
    itemIds.push(rows[0].id);
  }
  return { batchId: batch[0].id, batchCode: batch[0].batch_code, itemIds };
}

export async function getAdviceItem(tx: Tx, id: string): Promise<AdviceItemView> {
  const rows = await tx<AdviceItemView[]>`
    select v.*, c.client_code, c.full_name as client_name, pr.full_name as advisor_name
    from public.v_advice_items v
    join public.clients c on c.id = v.client_id
    left join public.profiles pr on pr.id = v.advisor_id
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
  return { newItemId: item[0].id, batchCode: batch[0].batch_code };
}

/** Cancel (or expire) the remaining part of a call. Executions already recorded stay counted. */
export async function closeAdvice(tx: Tx, adviceItemId: string, status: "CANCELLED" | "EXPIRED", reason: string): Promise<void> {
  if (!reason.trim()) throw new AppError("A reason is required.");
  const item = await getAdviceItem(tx, adviceItemId);
  if (!item.is_open) throw new AppError(`Call is already ${item.status}.`);
  await setAuditReason(tx, reason);
  await tx`update public.advice_items set status = ${status}, status_reason = ${reason} where id = ${adviceItemId}`;
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
    select v.*, c.client_code, c.full_name as client_name, pr.full_name as advisor_name
    from public.v_advice_items v
    join public.clients c on c.id = v.client_id
    left join public.profiles pr on pr.id = v.advisor_id
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
