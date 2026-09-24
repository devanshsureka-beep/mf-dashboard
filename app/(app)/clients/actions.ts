"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { runAction, type ActionResult } from "@/lib/actions";
import { AppError } from "@/lib/errors";
import { actionTx, ADVISORY_ROLES } from "@/lib/server";
import { createClient, reassignPrimaryAdvisor, updateClient } from "@/services/clients";
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
