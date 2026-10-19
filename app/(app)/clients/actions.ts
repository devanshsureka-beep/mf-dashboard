"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { runAction, type ActionResult } from "@/lib/actions";
import { AppError } from "@/lib/errors";
import { actionTx, ADVISORY_ROLES } from "@/lib/server";
import { createClient, reassignPrimaryAdvisor, updateClient } from "@/services/clients";
import { deleteClients, restoreClients } from "@/services/client-admin";
import { saveHoldingCorrection } from "@/services/holding-corrections";
import { RISK_PROFILES, CLIENT_STATUSES } from "@/types/domain";

const clientSchema = z.object({
  full_name: z.string().trim().min(2, "Full name is required"),
  email: z.union([z.email("Invalid email"), z.literal("")]).optional(),
  phone: z.string().trim().max(30).optional(),
  pan: z.union([z.string().trim().toUpperCase().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, "PAN format is ABCDE1234F"), z.literal("")]).optional(),
  onboarding_date: z.string().optional(),
  risk_profile: z.union([z.enum(RISK_PROFILES as [string, ...string[]]), z.literal("")]).optional(),
  goal: z.string().trim().max(500).optional(),
  status: z.enum(CLIENT_STATUSES as [string, ...string[]]).default("ONBOARDING"),
  next_review_date: z.string().optional(),
  advisor_id: z.string().optional(),
});

function parseClient(fd: FormData) {
  const parsed = clientSchema.safeParse(Object.fromEntries(fd));
  if (!parsed.success) throw new AppError(parsed.error.issues[0].message);
  return parsed.data;
}

export async function createClientAction(_p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  let id = "";
  const res = await runAction("createClient", async () => {
    const input = parseClient(fd);
    const created = await actionTx((tx, actor) => createClient(tx, actor, input), { roles: ADVISORY_ROLES });
    id = created.id;
  });
  if (!res.ok) return res;
  revalidatePath("/clients");
  redirect(`/clients/${id}`);
}

export async function updateClientAction(clientId: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction("updateClient", async () => {
    const input = parseClient(fd);
    await actionTx((tx) => updateClient(tx, clientId, input), { roles: ADVISORY_ROLES });
    revalidatePath(`/clients/${clientId}`);
    return "Client details saved.";
  });
}

export async function reassignAdvisorAction(clientId: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction("reassignAdvisor", async () => {
    const advisorId = String(fd.get("advisor_id") ?? "");
    if (!advisorId) throw new AppError("Choose an advisor.");
    await actionTx((tx, actor) => reassignPrimaryAdvisor(tx, actor, clientId, advisorId), {
      roles: ["ADMIN"],
      reason: String(fd.get("reason") ?? "") || "Advisor reassigned",
    });
    revalidatePath(`/clients/${clientId}`);
    return "Primary advisor updated.";
  });
}

/** Admin: delete the ticked clients (hidden everywhere, history kept, can be restored). */
export async function deleteClientsAction(_p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction("deleteClients", async () => {
    const ids = fd.getAll("ids").map(String);
    const reason = String(fd.get("reason") ?? "");
    const n = await actionTx((tx, actor) => deleteClients(tx, actor, ids, reason), { roles: ["ADMIN"] });
    revalidatePath("/clients");
    revalidatePath("/");
    return `${n} client(s) deleted. They are hidden everywhere; restore them from "Deleted clients" if needed.`;
  });
}

/** Admin: restore deleted clients. */
export async function restoreClientsAction(_p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction("restoreClients", async () => {
    const ids = fd.getAll("ids").map(String);
    const n = await actionTx((tx, actor) => restoreClients(tx, actor, ids, String(fd.get("reason") ?? "")), { roles: ["ADMIN"] });
    revalidatePath("/clients");
    revalidatePath("/");
    return `${n} client(s) restored.`;
  });
}

/** Admin: give the ticked clients a new primary advisor (old assignments are closed, never deleted). */
export async function reassignClientsAction(_p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction("reassignClients", async () => {
    const ids = [...new Set(fd.getAll("ids").map(String))].filter((x) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x));
    const advisorId = String(fd.get("advisor_id") ?? "");
    const reason = String(fd.get("reason") ?? "").trim();
    if (!ids.length) throw new AppError("Tick at least one client.");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(advisorId)) throw new AppError("Choose an advisor.");
    if (!reason) throw new AppError("A reason is required.");
    const n = await actionTx(async (tx, actor) => {
      const ok = await tx`select 1 from public.profiles where id = ${advisorId} and is_active and role in ('ADVISOR', 'ADMIN')`;
      if (!ok.length) throw new AppError("That person is not an active advisor.");
      const live = await tx<{ id: string }[]>`select id from public.clients where id = any(${ids}::uuid[]) and deleted_at is null`;
      for (const c of live) await reassignPrimaryAdvisor(tx, actor, c.id, advisorId);
      return live.length;
    }, { roles: ["ADMIN"], reason });
    revalidatePath("/clients");
    revalidatePath("/");
    return `${n} client(s) moved to the new advisor.`;
  });
}

const holdingsSchema = z.object({
  clientId: z.uuid(),
  baseSnapshotId: z.uuid(),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose the date the holdings are as of"),
  reason: z.string().trim().min(3, "Give a reason for the change").max(1000),
  rows: z.array(z.object({
    holdingId: z.uuid().nullable(),
    fundRef: z.string().regex(/^sec:[0-9a-f-]{36}$|^isin:[A-Z]{2}[A-Z0-9]{9}[0-9]$/i).nullable(),
    folio: z.string().max(40).nullable(),
    units: z.number().positive("Units must be more than 0 (remove the fund instead)"),
  })).max(500),
});

/** Edit holdings: saves a correction snapshot (the CAS stays as it was). */
export async function saveHoldingsAction(input: unknown): Promise<ActionResult> {
  return runAction("saveHoldings", async () => {
    const parsed = holdingsSchema.safeParse(input);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message);
    const { changes } = await actionTx((tx, actor) => saveHoldingCorrection(tx, actor, parsed.data), { roles: ADVISORY_ROLES });
    revalidatePath(`/clients/${parsed.data.clientId}`);
    return `Holdings saved · ${changes.length} ${changes.length === 1 ? "change" : "changes"}`;
  });
}
