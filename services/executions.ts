import type { Actor, Tx } from "@/lib/db/tx";
import { setAuditReason } from "@/lib/db/tx";
import { AppError } from "@/lib/errors";
import { overExecution } from "@/lib/domain/advice-rules";
import type { ExecutionRow, VerificationType } from "@/types/domain";
import { getAdviceItem } from "./advice";

export interface RecordExecutionInput {
  adviceItemId: string;
  executionDate: string;
  executionTime?: string | null;
  executedAmount: number;
  executedUnits?: number | null;
  executionPrice?: number | null;
  verificationType: Exclude<VerificationType, "CAS_VERIFIED">;
  status?: "EXECUTED" | "PARTIAL" | "PENDING";
  notes?: string | null;
  proofDocumentId?: string | null;
  allowOverExecution?: boolean;
}

/**
 * Record what the client actually did. Multiple (partial) executions per call
 * are supported; the call's status is derived by the database.
 */
export async function recordExecution(tx: Tx, actor: Actor, input: RecordExecutionInput): Promise<{ executionId: string; adviceStatus: string }> {
  const advice = await getAdviceItem(tx, input.adviceItemId);
  if (!(input.executedAmount > 0) && !(Number(input.executedUnits) > 0)) {
    throw new AppError("Enter the executed amount (and units if known).");
  }
  if (advice.quantity_basis === "UNITS" && !(Number(input.executedUnits) > 0)) {
    throw new AppError("This is a unit-based call: executed units are required.");
  }
  if (!["ISSUED", "PARTIALLY_EXECUTED"].includes(advice.status) && !input.notes?.trim()) {
    throw new AppError(`The call is ${advice.status}. Add a note explaining why an execution is recorded against it.`);
  }
  const over = overExecution(
    {
      quantityBasis: advice.quantity_basis,
      advisedAmount: advice.advised_amount,
      advisedUnits: advice.advised_units,
      executedAmount: advice.executed_amount,
      executedUnits: advice.executed_units,
    },
    { amount: input.executedAmount, units: input.executedUnits },
  );
  if (over.exceeds && !input.allowOverExecution) {
    throw new AppError(`${over.message} Tick "allow over-execution" if this is correct.`);
  }

  const rows = await tx<{ id: string }[]>`
    insert into public.executions (client_id, advice_item_id, security_id, execution_date, execution_time, executed_amount,
                                   executed_units, execution_price, verification_type, status, notes, proof_document_id, created_by)
    values (${advice.client_id}, ${advice.id}, ${advice.security_id}, ${input.executionDate}, ${input.executionTime || null},
            ${input.executedAmount || 0}, ${input.executedUnits || null}, ${input.executionPrice || null},
            ${input.verificationType}, ${input.status ?? "EXECUTED"}, ${input.notes || null},
            ${input.proofDocumentId || null}, ${actor.id})
    returning id`;
  const after = await tx<{ status: string }[]>`select status from public.advice_items where id = ${advice.id}`;
  return { executionId: rows[0].id, adviceStatus: after[0].status };
}

/** Reject / cancel a recorded execution (never deleted). Call status is re-derived. */
export async function voidExecution(tx: Tx, executionId: string, status: "REJECTED" | "CANCELLED", reason: string): Promise<void> {
  if (!reason.trim()) throw new AppError("A reason is required.");
  await setAuditReason(tx, reason);
  const res = await tx`
    update public.executions set status = ${status}, status_reason = ${reason}
    where id = ${executionId} and status not in ('REJECTED', 'CANCELLED')`;
  if (res.count === 0) throw new AppError("Execution not found or already voided.");
}

/** Confirm a PENDING execution report (e.g. order placed, now allotted). */
export async function confirmPendingExecution(tx: Tx, executionId: string, note?: string | null): Promise<void> {
  await setAuditReason(tx, note || "Pending execution confirmed");
  const res = await tx`update public.executions set status = 'EXECUTED' where id = ${executionId} and status = 'PENDING'`;
  if (res.count === 0) throw new AppError("Only PENDING executions can be confirmed.");
}

export async function listExecutions(tx: Tx, f: { clientId?: string; limit?: number } = {}): Promise<ExecutionRow[]> {
  return tx<ExecutionRow[]>`
    select e.*, a.scheme_name, a.action, c.full_name as client_name, c.client_code, pr.full_name as created_by_name
    from public.executions e
    join public.advice_items a on a.id = e.advice_item_id
    join public.clients c on c.id = e.client_id
    left join public.profiles pr on pr.id = e.created_by
    where (${f.clientId ?? null}::uuid is null or e.client_id = ${f.clientId ?? null})
    order by e.execution_date desc, e.created_at desc
    limit ${f.limit ?? 300}`;
}

export { getAdviceItem };
