"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { optStr, reqNum, reqStr, runAction, str, type ActionResult } from "@/lib/actions";
import { AppError } from "@/lib/errors";
import { fromISTDateTimeLocal } from "@/lib/format";
import { actionTx, ADVISORY_ROLES } from "@/lib/server";
import { resolveFundRef, searchFunds, type FundOption } from "@/services/fund-search";
import { closeAdvice, issueAdvice, reviseAdvice } from "@/services/advice";
import { adviseSipStops } from "@/services/plans";
import { correctAdvice, correctExecution } from "@/services/corrections";
import { addNote } from "@/services/notes";
import { CHANNELS, type Channel } from "@/types/domain";

const itemSchema = z.object({
  plan_item_id: z.uuid().nullable().optional(),
  // A known fund (uuid / "sec:<uuid>") or an AMFI scheme picked by ISIN ("isin:<ISIN>").
  security_id: z.string().regex(/^(sec:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^isin:[A-Z]{2}[A-Z0-9]{9}[0-9]$/i, "Choose a fund for every call"),
  action: z.enum(["BUY", "SELL"]),
  quantity_basis: z.enum(["AMOUNT", "UNITS"]),
  advised_amount: z.coerce.number().positive("Every call needs a rupee amount (estimate for unit calls)"),
  advised_units: z.coerce.number().positive().nullable().optional(),
  reference_price: z.coerce.number().positive().nullable().optional(),
  valid_until: z.iso.date().nullable().optional(),
});

/** A running SIP to stop (full portfolio redemption): a STOP line on the active plan, advised with the calls. */
const sipStopSchema = z.object({
  security_id: z.uuid(),
  scheme_name: z.string().trim().min(1).max(300),
  amount: z.coerce.number().positive(),
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
    let rawStops: unknown;
    try {
      rawStops = JSON.parse(str(fd, "sip_stops") || "[]");
    } catch {
      throw new AppError("Could not read the SIP stops.");
    }
    const stops = z.array(sipStopSchema).max(100).safeParse(rawStops);
    if (!stops.success) throw new AppError("Could not read the SIP stops.");
    const parsed = z.array(itemSchema).min(stops.data.length ? 0 : 1, "Add at least one call").safeParse(raw);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message);
    const out = await actionTx(async (tx, actor) => {
      const items = [];
      for (const i of parsed.data) items.push({ ...i, security_id: await resolveFundRef(tx, i.security_id, actor.id) });
      const communicatedAt = when(fd);
      const batch = items.length ? await issueAdvice(tx, actor, {
        clientId,
        advisorId: optStr(fd, "advisor_id"),
        communicatedAt,
        channel: channel(fd),
        notes: optStr(fd, "notes"),
        items,
      }) : null;
      // The SIP side, kept apart from Buy / Sell: a STOP line per SIP, advised now; the next CAS ticks it done.
      await adviseSipStops(tx, actor, clientId, stops.data, `Advised with the full portfolio redemption (${channel(fd).toLowerCase().replace("_", " ")})`);
      return batch;
    }, { roles: ADVISORY_ROLES });
    batchId = out?.batchId ?? "";
  });
  if (!res.ok) return res;
  revalidatePath("/advice");
  revalidatePath(`/clients/${clientId}`);
  // A round from Find clients: straight on to the next client, same time and channel.
  const round = fd.has("queue_done") ? queueNext(fd, 1, clientId) : null;
  if (round) redirect(round);
  redirect(batchId ? `/advice?client=${clientId}&issued=${batchId}` : `/clients/${clientId}?tab=tranches#sip-lines`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Where a round goes after this client: the next one's Issue call page, or
 * back to Find clients when it was the last. Only client ids and the time and
 * channel typed go into the link.
 */
function queueNext(fd: FormData, advised: number, current: string): string {
  const next = [...new Set(str(fd, "queue_next").split(",").map((x) => x.toLowerCase()))]
    .filter((x) => UUID.test(x) && x !== current.toLowerCase()).slice(0, 300);
  const done = (Number(str(fd, "queue_done")) || 0) + advised;
  if (!next.length) return `/advice/find?round=${done}`;
  const q = new URLSearchParams({ client: next[0], done: String(done) });
  const skipped = Math.max(0, Math.floor(Number(str(fd, "queue_skipped")) || 0));
  if (skipped) q.set("skipped", String(skipped));
  if (next.length > 1) q.set("queue", next.slice(1).join(","));
  const at = str(fd, "communicated_at");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(at)) q.set("at", at);
  const ch = str(fd, "channel");
  if ((CHANNELS as readonly string[]).includes(ch)) q.set("ch", ch);
  return `/advice/new?${q.toString()}`;
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

/** Fund search for the call forms (every AMFI scheme + funds already in use). */
export async function searchFundsAction(q: string): Promise<FundOption[]> {
  if (typeof q !== "string" || q.trim().length < 2) return [];
  return actionTx((tx) => searchFunds(tx, q.slice(0, 80)));
}

/** Admin: correct a recorded call (amount, units, fund, plan line, date, channel). */
export async function correctAdviceAction(itemId: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction("correctAdvice", async () => {
    const basis = reqStr(fd, "quantity_basis") === "UNITS" ? "UNITS" : "AMOUNT";
    const units = optStr(fd, "advised_units");
    const price = optStr(fd, "reference_price");
    const planItem = optStr(fd, "plan_item_id");
    await actionTx((tx, actor) => correctAdvice(tx, actor, itemId, {
      advisedAmount: reqNum(fd, "advised_amount", "Advised amount"),
      advisedUnits: units ? Number(units) : null,
      quantityBasis: basis,
      referencePrice: price ? Number(price) : null,
      planItemId: planItem && planItem !== "OFF_PLAN" ? planItem : null,
      securityId: reqStr(fd, "security_id", "Fund"),
      communicatedAt: when(fd),
      channel: channel(fd),
      reason: reqStr(fd, "reason", "Reason"),
    }), { roles: ["ADMIN"] });
    revalidatePath(`/advice/items/${itemId}`);
    revalidatePath("/");
    return "Call corrected. The plan numbers and the call's status are updated.";
  });
}

/** Admin: correct a recorded execution (amount, units, date, NAV). */
export async function correctExecutionAction(itemId: string, executionId: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction("correctExecution", async () => {
    const units = optStr(fd, "executed_units");
    const price = optStr(fd, "execution_price");
    await actionTx((tx, actor) => correctExecution(tx, actor, executionId, {
      executedAmount: reqNum(fd, "executed_amount", "Executed amount"),
      executedUnits: units ? Number(units) : null,
      executionDate: reqStr(fd, "execution_date", "Execution date"),
      executionPrice: price ? Number(price) : null,
      reason: reqStr(fd, "reason", "Reason"),
    }), { roles: ["ADMIN"] });
    revalidatePath(`/advice/items/${itemId}`);
    revalidatePath("/");
    return "Execution corrected. The call's status and the plan numbers are updated.";
  });
}
