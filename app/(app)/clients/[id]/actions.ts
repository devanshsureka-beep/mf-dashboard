"use server";

import { settleSipInstalments } from "@/services/reconciliation";

import { revalidatePath } from "next/cache";
import { optStr, reqStr, runAction, type ActionResult } from "@/lib/actions";
import { AppError, logServerError } from "@/lib/errors";
import { actionTx } from "@/lib/server";
import { linkCallsToPlan } from "@/services/advice";
import { addNote, completeFollowUp } from "@/services/notes";
import { setSipStatus } from "@/services/plans";
import { syncSipLinesFromCas, syncSipLinesQuietly } from "@/services/sip-status";

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
    return n ? `${n} SIP line(s) updated from the CAS.` : "Nothing new: no other SIP line is shown done in the CAS yet.";
  });
}

/** ADMIN: re-check SIP lines for every client with an active plan. */
export async function recheckAllSipsAction(_p: ActionResult | null): Promise<ActionResult> {
  return runAction("recheckAllSips", async () => {
    const r = await actionTx(async (tx, actor) => {
      const clients = await tx<{ client_id: string }[]>`
        select distinct s.client_id from public.sip_plan_items s
        join public.advisory_plans p on p.id = s.plan_id and p.status = 'ACTIVE'
        where s.status in ('PLANNED', 'ADVISED')`;
      let lines = 0;
      // Each client on its own savepoint: one failing client does not undo the others.
      for (const c of clients) lines += await syncSipLinesQuietly(tx, c.client_id);
      // SIP instalments an older reader left as trades (or that were recorded as calls) become instalments again.
      // In its own savepoint: a failure here never undoes the SIP lines updated above.
      const settled = await (tx as unknown as { savepoint: <T>(cb: (sp: typeof tx) => Promise<T>) => Promise<T> })
        .savepoint((sp) => settleSipInstalments(sp, actor))
        .catch((e: unknown) => {
          logServerError("recheckAllSips.settle", e);
          return { reclassified: 0, callsCancelled: 0, failed: true as const };
        });
      return { clients: clients.length, lines, settled };
    }, { roles: ["ADMIN"] });
    revalidatePath("/clients");
    revalidatePath("/reconciliation");
    if ("failed" in r.settled) return `Checked ${r.clients} client(s) with open SIP lines: ${r.lines} line(s) updated from the CAS. Re-reading SIP instalments shown as trades failed; it is logged. Try again later.`;
    return `Checked ${r.clients} client(s) with open SIP lines: ${r.lines} line(s) updated from the CAS. ${r.settled.reclassified} SIP instalment(s) no longer shown as trades${r.settled.callsCancelled ? `, ${r.settled.callsCancelled} call(s) recorded from them cancelled` : ""}.`;
  });
}
