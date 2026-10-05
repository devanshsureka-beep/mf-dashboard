import type { Actor, Tx } from "@/lib/db/tx";
import { setAuditReason } from "@/lib/db/tx";
import { AppError } from "@/lib/errors";
import type { Channel } from "@/types/domain";

/**
 * Admin corrections of calls and executions (a typo in the amount, the wrong
 * fund or plan line, the wrong date). Admin only, always with a reason; the
 * audit log keeps the old and new values. The database enforces the same rule
 * (app.admin_correction) and re-derives the call's status afterwards.
 */

function assertAdmin(actor: Actor, reason: string): string {
  if (actor.role !== "ADMIN") throw new AppError("Only an admin can correct a recorded call or execution.", "FORBIDDEN");
  const r = reason.trim();
  if (!r) throw new AppError("A reason is required for a correction.");
  return r;
}

export interface CallCorrection {
  advisedAmount: number;
  advisedUnits: number | null;
  quantityBasis: "AMOUNT" | "UNITS";
  referencePrice: number | null;
  /** Plan line to link to; null = off-plan. */
  planItemId: string | null;
  /** Fund of the call (off-plan calls); a plan line brings its own fund. */
  securityId: string;
  communicatedAt: Date;
  channel: Channel;
  reason: string;
}

export async function correctAdvice(tx: Tx, actor: Actor, itemId: string, c: CallCorrection): Promise<void> {
  const reason = assertAdmin(actor, c.reason);
  const cur = (await tx<{ advice_batch_id: string; client_id: string; security_id: string }[]>`
    select advice_batch_id, client_id, security_id from public.advice_items where id = ${itemId} for update`)[0];
  if (!cur) throw new AppError("Call not found.", "NOT_FOUND");
  if (!(c.advisedAmount >= 0)) throw new AppError("Enter the advised amount.");
  if (c.quantityBasis === "UNITS" && !(Number(c.advisedUnits) > 0)) throw new AppError("Enter the advised units for a units-based call.");
  if (c.communicatedAt.getTime() > Date.now()) throw new AppError("A call cannot be dated in the future.");

  let securityId = c.securityId;
  if (c.planItemId) {
    const pi = (await tx<{ security_id: string | null; client_id: string }[]>`
      select security_id, client_id from public.advisory_plan_items where id = ${c.planItemId}`)[0];
    if (!pi || pi.client_id !== cur.client_id) throw new AppError("That plan line is not this client's.");
    if (pi.security_id) securityId = pi.security_id;
  }
  const sec = (await tx<{ scheme_name: string }[]>`select scheme_name from public.security_master where id = ${securityId}`)[0];
  if (!sec) throw new AppError("Fund not found.");

  await setAuditReason(tx, `Admin correction: ${reason}`);
  await tx`
    update public.advice_items set
      advised_amount = ${c.advisedAmount}, advised_units = ${c.quantityBasis === "UNITS" ? c.advisedUnits : c.advisedUnits ?? null},
      quantity_basis = ${c.quantityBasis}, reference_price = ${c.referencePrice}, plan_item_id = ${c.planItemId},
      security_id = ${securityId}, scheme_name = ${sec.scheme_name}
    where id = ${itemId}`;
  if (securityId !== cur.security_id) {
    // Executions follow the call's fund.
    await tx`update public.executions set security_id = ${securityId} where advice_item_id = ${itemId}`;
  }
  // When and how the client was told belongs to the call batch.
  await tx`
    update public.advice_batches set communicated_at = ${c.communicatedAt}, communication_channel = ${c.channel}
    where id = ${cur.advice_batch_id}
      and (communicated_at is distinct from ${c.communicatedAt} or communication_channel is distinct from ${c.channel})`;
}

export interface ExecutionCorrection {
  executedAmount: number;
  executedUnits: number | null;
  executionDate: string; // YYYY-MM-DD
  executionPrice: number | null;
  reason: string;
}

export async function correctExecution(tx: Tx, actor: Actor, executionId: string, c: ExecutionCorrection): Promise<void> {
  const reason = assertAdmin(actor, c.reason);
  if (!(c.executedAmount >= 0)) throw new AppError("Enter the executed amount.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.executionDate)) throw new AppError("Enter the execution date.");
  await setAuditReason(tx, `Admin correction: ${reason}`);
  const res = await tx`
    update public.executions set
      executed_amount = ${c.executedAmount}, executed_units = ${c.executedUnits},
      execution_date = ${c.executionDate}::date, execution_price = ${c.executionPrice}
    where id = ${executionId}`;
  if (res.count === 0) throw new AppError("Execution not found.", "NOT_FOUND");
}
