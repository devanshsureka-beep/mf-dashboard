"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { optStr, reqNum, reqStr, runAction, str, type ActionResult } from "@/lib/actions";
import { AppError } from "@/lib/errors";
import { fromISTDateTimeLocal } from "@/lib/format";
import { actionTx, ADVISORY_ROLES } from "@/lib/server";
import { closeAdvice, issueAdvice, reviseAdvice } from "@/services/advice";
import { addNote } from "@/services/notes";
import { CHANNELS, type Channel } from "@/types/domain";

const itemSchema = z.object({
  plan_item_id: z.uuid().nullable().optional(),
  security_id: z.uuid({ message: "Choose a security for every call" }),
  action: z.enum(["BUY", "SELL", "SWITCH"]),
  quantity_basis: z.enum(["AMOUNT", "UNITS"]),
  advised_amount: z.coerce.number().positive("Every call needs a rupee amount (estimate for unit calls)"),
  advised_units: z.coerce.number().positive().nullable().optional(),
  reference_price: z.coerce.number().positive().nullable().optional(),
  valid_until: z.iso.date().nullable().optional(),
});

function channel(fd: FormData): Channel {
  const c = reqStr(fd, "channel", "Channel") as Channel;
  if (!CHANNELS.includes(c)) throw new AppError("Invalid channel.");
  return c;
}

function when(fd: FormData): Date {
  const d = fromISTDateTimeLocal(reqStr(fd, "communicated_at", "Communication time"));
  if (Number.isNaN(d.getTime())) throw new AppError("Invalid communication time.");
  return d;
}

export async function issueAdviceAction(clientId: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  let batchId = "";
  const res = await runAction("issueAdvice", async () => {
    let raw: unknown;
    try {
      raw = JSON.parse(str(fd, "items") || "[]");
    } catch {
      throw new AppError("Could not read the calls.");
    }
    const parsed = z.array(itemSchema).min(1, "Add at least one call").safeParse(raw);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message);
    const out = await actionTx((tx, actor) => issueAdvice(tx, actor, {
      clientId,
      advisorId: optStr(fd, "advisor_id"),
      communicatedAt: when(fd),
      channel: channel(fd),
      notes: optStr(fd, "notes"),
      items: parsed.data,
    }), { roles: ADVISORY_ROLES });
    batchId = out.batchId;
  });
  if (!res.ok) return res;
  revalidatePath("/advice");
  revalidatePath(`/clients/${clientId}`);
  redirect(`/advice?client=${clientId}&issued=${batchId}`);
}

export async function reviseAdviceAction(itemId: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  let newId = "";
  const res = await runAction("reviseAdvice", async () => {
    const out = await actionTx((tx, actor) => reviseAdvice(tx, actor, {
      adviceItemId: itemId,
      newTotalAmount: reqNum(fd, "new_total_amount", "New total amount"),
      newTotalUnits: fd.get("new_total_units") ? reqNum(fd, "new_total_units") : null,
      referencePrice: fd.get("reference_price") ? reqNum(fd, "reference_price") : null,
      reason: reqStr(fd, "reason", "Reason"),
      communicatedAt: when(fd),
      channel: channel(fd),
    }), { roles: ADVISORY_ROLES });
    newId = out.newItemId;
  });
  if (!res.ok) return res;
  revalidatePath("/advice");
  redirect(`/advice/items/${newId}`);
}

export async function closeAdviceAction(itemId: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction("closeAdvice", async () => {
    const status = reqStr(fd, "status") as "CANCELLED" | "EXPIRED";
    if (!["CANCELLED", "EXPIRED"].includes(status)) throw new AppError("Invalid status.");
    await actionTx((tx) => closeAdvice(tx, itemId, status, reqStr(fd, "reason", "Reason")), { roles: ADVISORY_ROLES });
    revalidatePath(`/advice/items/${itemId}`);
    revalidatePath("/executions/pending");
    return `Call marked ${status.toLowerCase()}. Already-executed quantity stays counted.`;
  });
}

export async function followUpNoteAction(clientId: string, itemId: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction("followUpNote", async () => {
    await actionTx((tx, actor) => addNote(tx, actor, {
      clientId, adviceItemId: itemId, noteType: "FOLLOW_UP",
      body: reqStr(fd, "body", "Note"), followUpDate: optStr(fd, "follow_up_date"),
    }));
    revalidatePath(`/advice/items/${itemId}`);
    return "Follow-up note added.";
  });
}
