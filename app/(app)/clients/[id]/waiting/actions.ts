"use server";

import { revalidatePath } from "next/cache";
import { runAction, type ActionResult } from "@/lib/actions";
import { AppError } from "@/lib/errors";
import { todayIST } from "@/lib/format";
import { actionTx, ADVISORY_ROLES } from "@/lib/server";
import { approveLine, keepWaiting, undoApproval, type ApproveLine } from "@/services/waiting-approve";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const opts = { roles: ADVISORY_ROLES };

function refresh(clientId: string) {
  revalidatePath(`/clients/${clientId}`);
  revalidatePath(`/clients/${clientId}/waiting`);
  revalidatePath("/clients");
  revalidatePath("/reconciliation");
  revalidatePath("/");
}

const text = (v: unknown, max = 60) => (typeof v === "string" ? v.slice(0, max) : null);

/** Approve the ticked lines of the waiting page: one transaction per line, so one bad line holds up no other. */
export async function approveWaitingAction(clientId: string, lines: ApproveLine[]): Promise<ActionResult & { failed?: { id: string; error: string }[] }> {
  if (!UUID.test(clientId)) return { ok: false, error: "Unknown client." };
  if (!Array.isArray(lines) || !lines.length) return { ok: false, error: "Tick the lines to approve." };
  if (lines.length > 200) return { ok: false, error: "Too many lines at once." };
  const today = todayIST();
  const failed: { id: string; error: string }[] = [];
  let ok = 0;
  for (const raw of lines) {
    const id = typeof raw?.id === "string" ? raw.id : "";
    const r = await runAction("approveWaitingLine", async () => {
      if (!raw || typeof raw !== "object" || !UUID.test(id) || (raw.kind !== "CALL" && raw.kind !== "SIP")) throw new AppError("Unknown line.");
      const line: ApproveLine = {
        kind: raw.kind, id, choice: text(raw.choice, 20) ?? "",
        amount: text(raw.amount), units: text(raw.units), date: text(raw.date, 10), reason: text(raw.reason, 500),
      };
      await actionTx((tx, actor) => approveLine(tx, actor, clientId, line, today), opts);
    });
    if (r.ok) ok++;
    else failed.push({ id, error: r.error });
  }
  refresh(clientId);
  if (!failed.length) return { ok: true, message: `${ok} ${ok === 1 ? "line" : "lines"} approved.` };
  return { ok: false, error: `${ok} approved; ${failed.length} not: see the lines marked in red.`, failed };
}

export async function undoApprovalAction(clientId: string, kind: "CALL" | "SIP", id: string): Promise<ActionResult> {
  return runAction("undoApproval", async () => {
    if (!UUID.test(clientId) || !UUID.test(id) || (kind !== "CALL" && kind !== "SIP")) throw new AppError("Unknown line.");
    await actionTx((tx) => undoApproval(tx, clientId, kind, id), opts);
    refresh(clientId);
    return "Undone: the line is waiting again.";
  });
}

/** CAS inbox: an approved trade this CAS does not show. Keep waiting (ask again at a later CAS) or undo the approval. */
export async function approvedNotInCasAction(clientId: string, executionId: string, casDate: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction("approvedNotInCas", async () => {
    if (!UUID.test(clientId) || !UUID.test(executionId) || !/^\d{4}-\d{2}-\d{2}$/.test(casDate)) throw new AppError("Unknown line.");
    const decision = String(fd.get("decision") ?? "");
    if (decision === "KEEP") await actionTx((tx) => keepWaiting(tx, clientId, executionId, casDate), opts);
    else if (decision === "UNDO") await actionTx((tx) => undoApproval(tx, clientId, "CALL", executionId), opts);
    else throw new AppError("Unknown decision.");
    refresh(clientId);
    return decision === "KEEP" ? "Kept waiting for a later CAS." : "Approval undone: the call is waiting again.";
  });
}
