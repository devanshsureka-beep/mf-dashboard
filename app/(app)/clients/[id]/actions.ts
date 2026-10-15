"use server";

import { revalidatePath } from "next/cache";
import { optStr, reqStr, runAction, type ActionResult } from "@/lib/actions";
import { AppError } from "@/lib/errors";
import { actionTx } from "@/lib/server";
import { linkCallsToPlan } from "@/services/advice";
import { addNote, completeFollowUp } from "@/services/notes";
import { setSipStatus } from "@/services/plans";
import { syncSipLinesFromCas } from "@/services/sip-status";

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

/** Re-check the plan's SIP lines against this client's CAS (started / changed / stopped since the report). */
export async function recheckSipAction(clientId: string, _p: ActionResult | null): Promise<ActionResult> {
  return runAction("recheckSip", async () => {
    const n = await actionTx((tx) => syncSipLinesFromCas(tx, clientId), { roles: ["ADMIN", "ADVISOR"] });
    revalidatePath(`/clients/${clientId}`);
    return n ? `${n} SIP line(s) marked done from the CAS.` : "Nothing new: no other SIP line is shown done in the CAS yet.";
  });
}

/** ADMIN: re-check SIP lines for every client with an active plan. */
export async function recheckAllSipsAction(_p: ActionResult | null): Promise<ActionResult> {
  return runAction("recheckAllSips", async () => {
    const r = await actionTx(async (tx) => {
      const clients = await tx<{ client_id: string }[]>`
        select distinct s.client_id from public.sip_plan_items s
        join public.advisory_plans p on p.id = s.plan_id and p.status = 'ACTIVE'
        where s.status in ('PLANNED', 'ADVISED')`;
      let lines = 0;
      for (const c of clients) lines += await syncSipLinesFromCas(tx, c.client_id);
      return { clients: clients.length, lines };
    }, { roles: ["ADMIN"] });
    revalidatePath("/clients");
    return `Checked ${r.clients} client(s) with open SIP lines: ${r.lines} line(s) marked done from the CAS.`;
  });
}
