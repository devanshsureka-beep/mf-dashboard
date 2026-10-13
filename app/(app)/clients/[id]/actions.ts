"use server";

import { revalidatePath } from "next/cache";
import { optStr, reqStr, runAction, type ActionResult } from "@/lib/actions";
import { AppError } from "@/lib/errors";
import { actionTx } from "@/lib/server";
import { linkCallsToPlan } from "@/services/advice";
import { addNote, completeFollowUp } from "@/services/notes";
import { setSipStatus } from "@/services/plans";

export async function addNoteAction(clientId: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction("addNote", async () => {
    await actionTx((tx, actor) =>
      addNote(tx, actor, {
        clientId,
        body: reqStr(fd, "body", "Note"),
        noteType: optStr(fd, "note_type") ?? "GENERAL",
        followUpDate: optStr(fd, "follow_up_date"),
      }),
    );
    revalidatePath(`/clients/${clientId}`);
    return "Note added.";
  });
}

export async function completeFollowUpAction(clientId: string, noteId: string, _p: ActionResult | null): Promise<ActionResult> {
  return runAction("completeFollowUp", async () => {
    await actionTx((tx) => completeFollowUp(tx, noteId));
    revalidatePath(`/clients/${clientId}`);
    return "Follow-up marked done.";
  });
}

export async function setSipStatusAction(clientId: string, sipId: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction("setSipStatus", async () => {
    const status = String(fd.get("status"));
    if (!["ADVISED", "COMPLETED", "CANCELLED"].includes(status)) throw new AppError("Invalid SIP status.");
    await actionTx((tx) => setSipStatus(tx, sipId, status as "ADVISED" | "COMPLETED" | "CANCELLED", optStr(fd, "note")));
    revalidatePath(`/clients/${clientId}`);
    return `SIP action marked ${status.toLowerCase()}.`;
  });
}

/** Admin: link calls outside the plan to the plan line of the same fund. */
export async function linkCallsToPlanAction(clientId: string, _p: ActionResult | null): Promise<ActionResult> {
  return runAction("linkCallsToPlan", async () => {
    const r = await actionTx((tx, actor) => linkCallsToPlan(tx, actor, clientId));
    revalidatePath(`/clients/${clientId}`);
    if (!r.linked) return r.left ? `No plan line for the ${r.left} call(s) outside the plan.` : "No calls outside the plan.";
    return `Linked ${r.linked} call(s) to the plan${r.left ? `; ${r.left} have no plan line for their fund` : ""}.`;
  });
}
