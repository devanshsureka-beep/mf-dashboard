"use server";

import { revalidatePath } from "next/cache";
import { num, optStr, reqStr, runAction, str, type ActionResult } from "@/lib/actions";
import type { Tx } from "@/lib/db/tx";
import { AppError } from "@/lib/errors";
import { todayIST } from "@/lib/format";
import { actionTx } from "@/lib/server";
import { fileFromForm, formHasFile, objectPath, uploadAsUser, type PreparedFile } from "@/lib/storage";
import { registerDocument } from "@/services/documents";
import { confirmPendingExecution, getAdviceItem, recordExecution, voidExecution } from "@/services/executions";
import { VERIFICATION_TYPES } from "@/types/domain";

export async function recordExecutionAction(adviceItemId: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction("recordExecution", async () => {
    const verification = reqStr(fd, "verification_type", "Verification") as (typeof VERIFICATION_TYPES)[number];
    if (!VERIFICATION_TYPES.includes(verification)) throw new AppError("Invalid verification type (CAS verification happens only through reconciliation).");
    const date = str(fd, "execution_date") || todayIST();
    const status = (str(fd, "status") || "EXECUTED") as "EXECUTED" | "PENDING";
    const hasProof = formHasFile(fd, "proof");
    if (verification === "PROOF_VERIFIED" && !hasProof) throw new AppError("Attach the proof document for PROOF_VERIFIED executions.");

    // Upload proof first (outside the DB transaction); the DB row references it.
    let prepared: PreparedFile | null = null;
    let path: string | null = null;
    const advice = await actionTx((tx) => getAdviceItem(tx, adviceItemId), { roles: ["ADMIN"] });
    if (hasProof) {
      prepared = await fileFromForm(fd, "proof");
      path = objectPath(advice.client_id, "EXECUTION_PROOF", prepared);
      await uploadAsUser(path, prepared);
    }

    const out = await actionTx(async (tx, actor) => {
      let proofId: string | null = null;
      if (prepared && path) {
        proofId = await registerDocument(tx, actor.id, {
          clientId: advice.client_id, type: "EXECUTION_PROOF", filePath: path, fileName: prepared.fileName,
          mimeType: prepared.mimeType, sizeBytes: prepared.size, sha256: prepared.sha256,
          description: `Proof for ${advice.batch_code} ${advice.action} ${advice.scheme_name}`,
        });
      }
      return recordExecution(tx, actor, {
        adviceItemId,
        executionDate: date,
        executionTime: optStr(fd, "execution_time"),
        executedAmount: num(fd, "executed_amount") ?? 0,
        executedUnits: num(fd, "executed_units"),
        executionPrice: num(fd, "execution_price"),
        verificationType: verification,
        status,
        notes: optStr(fd, "notes"),
        proofDocumentId: proofId,
        allowOverExecution: str(fd, "allow_over") === "yes",
      });
      // Done comes from the CAS; recording by hand is an admin fallback.
    }, { roles: ["ADMIN"] });
    revalidatePath("/executions/pending");
    revalidatePath(`/advice/items/${adviceItemId}`);
    revalidatePath(`/clients/${advice.client_id}`);
    return `Execution recorded. Call is now ${out.adviceStatus.replace("_", " ").toLowerCase()}.`;
  });
}

/** Hand corrections apply to this call's executions only, and never to one the CAS verified (reconciliation owns those). */
async function assertHandExecution(tx: Tx, adviceItemId: string, executionId: string): Promise<void> {
  const [e] = await tx<{ verification_type: string }[]>`
    select verification_type from public.executions where id = ${executionId} and advice_item_id = ${adviceItemId}`;
  if (!e) throw new AppError("Execution not found for this call.", "NOT_FOUND");
  if (e.verification_type === "CAS_VERIFIED") throw new AppError("This execution was verified from a CAS; correct it through the CAS inbox instead.");
}

export async function voidExecutionAction(adviceItemId: string, executionId: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction("voidExecution", async () => {
    const status = reqStr(fd, "status") as "REJECTED" | "CANCELLED";
    if (!["REJECTED", "CANCELLED"].includes(status)) throw new AppError("Invalid status.");
    const reason = reqStr(fd, "reason", "Reason");
    await actionTx(async (tx) => {
      await assertHandExecution(tx, adviceItemId, executionId);
      await voidExecution(tx, executionId, status, reason);
    }, { roles: ["ADMIN"] });
    revalidatePath(`/advice/items/${adviceItemId}`);
    return `Execution marked ${status.toLowerCase()}; call status recalculated.`;
  });
}

export async function confirmPendingExecutionAction(adviceItemId: string, executionId: string, _p: ActionResult | null): Promise<ActionResult> {
  return runAction("confirmPendingExecution", async () => {
    await actionTx(async (tx) => {
      await assertHandExecution(tx, adviceItemId, executionId);
      await confirmPendingExecution(tx, executionId);
    }, { roles: ["ADMIN"] });
    revalidatePath(`/advice/items/${adviceItemId}`);
    return "Execution confirmed.";
  });
}

