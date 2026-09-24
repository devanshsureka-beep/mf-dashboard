"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { num, optStr, reqNum, reqStr, runAction, str, type ActionResult } from "@/lib/actions";
import { AppError } from "@/lib/errors";
import { actionTx, ADVISORY_ROLES } from "@/lib/server";
import {
  addPlanItem, addSipItem, approvePlan, cancelPlanItem, closePlan, createDraftPlan, deleteDraftPlanItem,
  deleteDraftSipItem, updatePlanItem, type PlanItemInput,
} from "@/services/plans";
import type { Tx } from "@/lib/db/tx";

const opts = { roles: ADVISORY_ROLES };

async function securityName(tx: Tx, id: string | null): Promise<string | null> {
  if (!id) return null;
  const r = await tx<{ scheme_name: string }[]>`select scheme_name from public.security_master where id = ${id}`;
  return r[0]?.scheme_name ?? null;
}

async function readItem(tx: Tx, fd: FormData): Promise<PlanItemInput> {
  const action = reqStr(fd, "action", "Action") as PlanItemInput["action"];
  if (!["SELL", "BUY", "RETAIN", "SWITCH"].includes(action)) throw new AppError("Invalid action.");
  const securityId = optStr(fd, "security_id");
  const name = (await securityName(tx, securityId)) ?? optStr(fd, "scheme_name");
  if (!name) throw new AppError("Choose a security.");
  const target = action === "RETAIN" ? num(fd, "target_amount") ?? 0 : reqNum(fd, "target_amount", "Target amount");
  if (target < 0) throw new AppError("Target amount cannot be negative.");
  return {
    security_id: securityId,
    scheme_name: name,
    folio_number: optStr(fd, "folio_number"),
    action,
    target_amount: target,
    target_units: num(fd, "target_units"),
    current_amount: num(fd, "current_amount"),
    target_weight: num(fd, "target_weight"),
    reason: optStr(fd, "reason"),
    priority: num(fd, "priority") ?? 100,
    notes: optStr(fd, "notes"),
  };
}

const refresh = (clientId: string, planId: string) => {
  revalidatePath(`/clients/${clientId}/plans/${planId}`);
  revalidatePath(`/clients/${clientId}`);
};

export async function createPlanAction(clientId: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  let planId = "";
  const res = await runAction("createPlan", async () => {
    planId = await actionTx((tx, actor) => createDraftPlan(tx, actor, {
      clientId,
      planName: reqStr(fd, "plan_name", "Plan name"),
      planDate: optStr(fd, "plan_date"),
      notes: optStr(fd, "notes"),
      fromSnapshotId: optStr(fd, "snapshot_id"),
    }), opts);
  });
  if (!res.ok) return res;
  redirect(`/clients/${clientId}/plans/${planId}`);
}

export async function addPlanItemAction(clientId: string, planId: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction("addPlanItem", async () => {
    await actionTx(async (tx, actor) => addPlanItem(tx, actor, planId, await readItem(tx, fd), optStr(fd, "change_reason")), opts);
    refresh(clientId, planId);
    return "Item added.";
  });
}

export async function updatePlanItemAction(clientId: string, planId: string, itemId: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction("updatePlanItem", async () => {
    await actionTx(async (tx) => updatePlanItem(tx, itemId, await readItem(tx, fd), optStr(fd, "change_reason")), opts);
    refresh(clientId, planId);
    return "Item updated.";
  });
}

export async function deletePlanItemAction(clientId: string, planId: string, itemId: string, _p: ActionResult | null): Promise<ActionResult> {
  return runAction("deletePlanItem", async () => {
    await actionTx((tx) => deleteDraftPlanItem(tx, itemId), opts);
    refresh(clientId, planId);
    return "Item removed from draft.";
  });
}

export async function cancelPlanItemAction(clientId: string, planId: string, itemId: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction("cancelPlanItem", async () => {
    await actionTx((tx) => cancelPlanItem(tx, itemId, reqStr(fd, "reason", "Reason")), opts);
    refresh(clientId, planId);
    return "Item cancelled.";
  });
}

export async function addSipAction(clientId: string, planId: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction("addSip", async () => {
    await actionTx(async (tx, actor) => {
      const securityId = optStr(fd, "security_id");
      const name = (await securityName(tx, securityId)) ?? optStr(fd, "scheme_name");
      if (!name) throw new AppError("Choose a scheme.");
      const action = reqStr(fd, "action") as "START" | "STOP" | "CHANGE";
      return addSipItem(tx, actor, planId, {
        security_id: securityId, scheme_name: name, action,
        old_amount: num(fd, "old_amount"), new_amount: num(fd, "new_amount"),
        frequency: str(fd, "frequency") || "MONTHLY", debit_day: num(fd, "debit_day"), notes: optStr(fd, "notes"),
      }, optStr(fd, "change_reason"));
    }, opts);
    refresh(clientId, planId);
    return "SIP action added.";
  });
}

export async function deleteSipAction(clientId: string, planId: string, sipId: string, _p: ActionResult | null): Promise<ActionResult> {
  return runAction("deleteSip", async () => {
    await actionTx((tx) => deleteDraftSipItem(tx, sipId), opts);
    refresh(clientId, planId);
    return "SIP item removed.";
  });
}

export async function resolveSipSecurityAction(clientId: string, planId: string, sipId: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction("resolveSipSecurity", async () => {
    const securityId = reqStr(fd, "security_id", "Security");
    await actionTx(async (tx) => {
      const name = await securityName(tx, securityId);
      await tx`update public.sip_plan_items set security_id = ${securityId}, scheme_name = ${name ?? ""}, needs_review = false where id = ${sipId}`;
    }, opts);
    refresh(clientId, planId);
    return "Security confirmed.";
  });
}

export async function approvePlanAction(clientId: string, planId: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction("approvePlan", async () => {
    if (str(fd, "confirm") !== "yes") throw new AppError("Tick the confirmation box to approve.");
    await actionTx((tx, actor) => approvePlan(tx, actor, planId, optStr(fd, "reason")), opts);
    refresh(clientId, planId);
    return "Plan approved and ACTIVE. Targets are now frozen; changes require a reason.";
  });
}

export async function closePlanAction(clientId: string, planId: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction("closePlan", async () => {
    const status = reqStr(fd, "status") as "COMPLETED" | "CANCELLED";
    await actionTx((tx) => closePlan(tx, planId, status, reqStr(fd, "reason", "Reason")), opts);
    refresh(clientId, planId);
    return `Plan marked ${status}.`;
  });
}
