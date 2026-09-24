"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { reqStr, runAction, str, type ActionResult } from "@/lib/actions";
import { AppError } from "@/lib/errors";
import { actionTx } from "@/lib/server";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

const ROLES = ["ADMIN", "ADVISOR", "OPERATIONS"] as const;
const schema = z.object({
  email: z.email(),
  full_name: z.string().trim().min(2),
  role: z.enum(ROLES),
  password: z.string().min(12, "Temporary password must be at least 12 characters"),
});

/** ADMIN only: create a staff account (public sign-up stays disabled). */
export async function createUserAction(_p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction("createUser", async () => {
    const parsed = schema.safeParse(Object.fromEntries(fd));
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message);
    // Authorise first (throws if not an active ADMIN).
    await actionTx(async () => null, { roles: ["ADMIN"] });
    let admin;
    try {
      admin = createSupabaseAdminClient();
    } catch {
      throw new AppError("SUPABASE_SERVICE_ROLE_KEY is not configured on the server.", "CONFIG");
    }
    const { data, error } = await admin.auth.admin.createUser({
      email: parsed.data.email,
      password: parsed.data.password,
      email_confirm: true,
      app_metadata: { mn_role: parsed.data.role, mn_full_name: parsed.data.full_name, mn_active: true },
    });
    if (error) throw new AppError(`Could not create user: ${error.message}`);
    // The auth trigger created the profile; make role/name explicit and audited.
    await actionTx((tx) => tx`
      update public.profiles set full_name = ${parsed.data.full_name}, role = ${parsed.data.role}, is_active = true
      where id = ${data.user.id}`, { roles: ["ADMIN"], reason: "Staff user created by admin" });
    revalidatePath("/admin/users");
    return `User ${parsed.data.email} created. Share the temporary password securely and ask them to change it.`;
  });
}

export async function updateUserAction(userId: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction("updateUser", async () => {
    const role = reqStr(fd, "role") as (typeof ROLES)[number];
    if (!ROLES.includes(role)) throw new AppError("Invalid role.");
    const active = str(fd, "is_active") === "yes";
    await actionTx(async (tx, actor) => {
      if (actor.id === userId && (!active || role !== "ADMIN")) throw new AppError("You cannot demote or deactivate yourself.");
      await tx`update public.profiles set role = ${role}, is_active = ${active} where id = ${userId}`;
    }, { roles: ["ADMIN"], reason: str(fd, "reason") || "Role / access changed by admin" });
    revalidatePath("/admin/users");
    return "User updated.";
  });
}

export async function assignClientAction(_p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction("assignClient", async () => {
    const clientId = reqStr(fd, "client_id", "Client");
    const userId = reqStr(fd, "user_id", "User");
    const role = reqStr(fd, "assignment_role") as "SECONDARY" | "OPERATIONS";
    if (!["SECONDARY", "OPERATIONS"].includes(role)) throw new AppError("Use the client page to change the PRIMARY advisor.");
    await actionTx((tx, actor) => tx`
      insert into public.client_advisor_assignments (client_id, advisor_id, assignment_role, created_by)
      values (${clientId}, ${userId}, ${role}, ${actor.id})`, { roles: ["ADMIN"], reason: "Additional assignment by admin" });
    revalidatePath("/admin/users");
    return "Assignment added.";
  });
}

export async function unassignAction(assignmentId: string, _p: ActionResult | null): Promise<ActionResult> {
  return runAction("unassign", async () => {
    await actionTx((tx) => tx`
      update public.client_advisor_assignments set is_active = false, unassigned_at = now()
      where id = ${assignmentId} and assignment_role <> 'PRIMARY'`, { roles: ["ADMIN"], reason: "Assignment removed by admin" });
    revalidatePath("/admin/users");
    return "Assignment removed (kept in history).";
  });
}
