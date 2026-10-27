"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { reqStr, runAction, str, type ActionResult } from "@/lib/actions";
import { AppError } from "@/lib/errors";
import { actionTx } from "@/lib/server";
import { asServer, type Tx } from "@/lib/db/tx";
import { authMode } from "@/lib/auth/mode";
import { createLink, sendLinkEmail } from "@/lib/auth/links";
import { hashPassword, passwordProblem } from "@/lib/auth/password";
import { newToken } from "@/lib/auth/tokens";
import { emailConfigured } from "@/lib/email";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { auditAuth, createAuthUser, revokeSessions, setPassword, setSignInAllowed } from "@/services/auth-users";
import { findProfileByEmail, removeTeamMember, restoreTeamMember } from "@/services/team";

function adminAuth() {
  try {
    return createSupabaseAdminClient();
  } catch {
    throw new AppError("SUPABASE_SERVICE_ROLE_KEY is not configured on the server.", "CONFIG");
  }
}

/**
 * Sign-in on or off, optionally with a new temporary password. AUTH_MODE=app writes auth.users in
 * this same transaction (and ends the user's sessions); AUTH_MODE=supabase goes through Supabase Auth
 * (a removed member's sessions stop at the next refresh).
 */
async function setSignIn(tx: Tx, userId: string, allowed: boolean, extra: { password?: string; role?: string; fullName?: string } = {}) {
  if (authMode() === "app") {
    const hash = extra.password ? await hashPassword(extra.password) : null;
    await asServer(tx, async () => {
      await setSignInAllowed(tx, userId, allowed, { role: extra.role, fullName: extra.fullName });
      if (hash) await setPassword(tx, userId, hash, true);
    });
    return;
  }
  const { error } = await adminAuth().auth.admin.updateUserById(userId, {
    ban_duration: allowed ? "none" : "876000h",
    ...(extra.password ? { password: extra.password } : {}),
    app_metadata: { mn_active: allowed, ...(extra.role ? { mn_role: extra.role } : {}), ...(extra.fullName ? { mn_full_name: extra.fullName } : {}) },
  });
  if (error) throw new AppError(`Could not ${allowed ? "restore" : "block"} sign-in: ${error.message}`);
}

const ROLES = ["ADMIN", "ADVISOR", "OPERATIONS"] as const;
const schema = z.object({
  email: z.email(),
  full_name: z.string().trim().min(2),
  role: z.enum(ROLES),
  // AUTH_MODE=app: "invite" emails a link to set a password instead of a temporary password.
  access: z.enum(["password", "invite"]).default("password"),
  password: z.string().optional(),
});

function temporaryPassword(p: string | undefined, email: string): string {
  const problem = passwordProblem(p ?? "", email);
  if (problem) throw new AppError(`Temporary password: ${problem}`);
  return p!;
}

/** ADMIN only: create a staff account (public sign-up stays disabled). */
export async function createUserAction(_p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction("createUser", async () => {
    const parsed = schema.safeParse(Object.fromEntries(fd));
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message);
    const invite = authMode() === "app" && parsed.data.access === "invite";
    if (invite && !emailConfigured()) throw new AppError("Email is not set up on the server: use a temporary password instead.");
    const password = invite ? null : temporaryPassword(parsed.data.password, parsed.data.email);
    // Authorise first (throws if not an active ADMIN).
    await actionTx(async () => null, { roles: ["ADMIN"] });
    // The email already has an account (e.g. someone removed earlier): add them back instead of failing.
    const existing = await actionTx((tx) => findProfileByEmail(tx, parsed.data.email), { roles: ["ADMIN"] });
    if (existing) {
      if (existing.active) throw new AppError(`${parsed.data.email} is already on the team. Change their role in the Staff list.`);
      // Database and sign-in change together: if Auth refuses, the restore rolls back.
      const sent = await actionTx(async (tx, actor) => {
        await restoreTeamMember(tx, actor, existing.id, { role: parsed.data.role, fullName: parsed.data.full_name });
        // Invited back: the old password must not work again, so a random one until the link is used.
        await setSignIn(tx, existing.id, true, { password: password ?? newToken(), role: parsed.data.role, fullName: parsed.data.full_name });
        return invite ? inviteInTx(tx, actor.id, existing.id, parsed.data.email, parsed.data.full_name) : null;
      }, { roles: ["ADMIN"] });
      revalidatePath("/admin/users");
      if (invite) return `${parsed.data.email} already had an account: added back as ${parsed.data.role}. ${await sent!()}`;
      return `${parsed.data.email} already had an account: added back as ${parsed.data.role} with the new temporary password.`;
    }
    if (authMode() === "app") {
      // The same rows Supabase Auth would write (auth.users + identity), so AUTH_MODE=supabase still works for this user.
      const hash = await hashPassword(password ?? newToken());
      const sent = await actionTx(async (tx, actor) => {
        const id = await asServer(tx, () => createAuthUser(tx, { email: parsed.data.email, fullName: parsed.data.full_name, role: parsed.data.role, passwordHash: hash, mustChangePassword: !invite }));
        return invite ? inviteInTx(tx, actor.id, id, parsed.data.email, parsed.data.full_name) : null;
      }, { roles: ["ADMIN"], reason: "Staff user created by admin" });
      revalidatePath("/admin/users");
      if (invite) return `User ${parsed.data.email} created. ${await sent!()}`;
      return `User ${parsed.data.email} created. Share the temporary password securely: they choose their own at the first sign-in.`;
    }
    const admin = adminAuth();
    const { data, error } = await admin.auth.admin.createUser({
      email: parsed.data.email,
      password: password!,
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
      const [p] = await tx<{ removed_at: Date | null }[]>`select removed_at from public.profiles where id = ${userId}`;
      if (p?.removed_at && active) throw new AppError("This person was removed from the team: use Add back.");
      // Live clients must keep a primary advisor who can advise them.
      if (!active || role === "OPERATIONS") {
        const [{ n }] = await tx<{ n: number }[]>`
          select count(*)::int as n from public.client_advisor_assignments a join public.clients c on c.id = a.client_id and c.deleted_at is null
          where a.advisor_id = ${userId} and a.is_active and a.assignment_role = 'PRIMARY'`;
        if (n > 0) throw new AppError(`This person is the primary advisor of ${n} client(s). Move those clients to another advisor first.`);
      }
      const [was] = await tx<{ role: string; is_active: boolean }[]>`select role, is_active from public.profiles where id = ${userId}`;
      await tx`update public.profiles set role = ${role}, is_active = ${active} where id = ${userId}`;
      // A new role or a deactivation takes effect at once: the person signs in again.
      if (authMode() === "app" && (was?.role !== role || was?.is_active !== active)) await asServer(tx, () => revokeSessions(tx, userId));
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
    await actionTx(async (tx, actor) => {
      const who = (await tx<{ role: string; is_active: boolean }[]>`select role, is_active from public.profiles where id = ${userId}`)[0];
      if (!who || !who.is_active) throw new AppError("Choose an active team member.");
      // A second advisor is an advisor or admin; an operations assignment is an operations member.
      if (role === "SECONDARY" ? who.role === "OPERATIONS" : who.role !== "OPERATIONS") {
        throw new AppError(role === "SECONDARY" ? "A second advisor must be an advisor or admin." : "An operations assignment must be an operations team member.");
      }
      await tx`
        insert into public.client_advisor_assignments (client_id, advisor_id, assignment_role, created_by)
        values (${clientId}, ${userId}, ${role}, ${actor.id})`;
    }, { roles: ["ADMIN"], reason: "Additional assignment by admin" });
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

/** ADMIN only: take someone off the team (history stays; sign-in and access end). */
export async function removeUserAction(userId: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction("removeUser", async () => {
    const reason = str(fd, "reason");
    // Database and sign-in change together: if blocking sign-in fails, nothing is marked removed (retry works).
    const who = await actionTx(async (tx, actor) => {
      const w = await removeTeamMember(tx, actor, userId, reason);
      await setSignIn(tx, userId, false);
      return w;
    }, { roles: ["ADMIN"] });
    revalidatePath("/admin/users");
    return `${who.fullName || who.email} removed from the team. Their past work stays in the history.`;
  });
}

/** ADMIN only: add a removed member back, with a role and a new temporary password. */
export async function restoreUserAction(userId: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction("restoreUser", async () => {
    const role = reqStr(fd, "role") as (typeof ROLES)[number];
    if (!ROLES.includes(role)) throw new AppError("Invalid role.");
    // Exactly as typed (not trimmed): the person signs in with the same characters.
    const raw = String(fd.get("password") ?? "");
    await actionTx(async (tx, actor) => {
      const [p] = await tx<{ email: string }[]>`select email from public.profiles where id = ${userId}`;
      const password = temporaryPassword(raw, p?.email ?? "");
      await restoreTeamMember(tx, actor, userId, { role });
      await setSignIn(tx, userId, true, { password, role });
    }, { roles: ["ADMIN"] });
    revalidatePath("/admin/users");
    return "Added back to the team. Share the temporary password securely.";
  });
}

/**
 * In the admin's transaction: a one-time invite link, stored hashed. Returns the step that emails it,
 * to run after the transaction commits (no email for a user that was not saved).
 */
async function inviteInTx(tx: Tx, adminId: string, userId: string, email: string, name: string): Promise<() => Promise<string>> {
  const link = await asServer(tx, async () => {
    const l = await createLink(tx, userId, "INVITE");
    await auditAuth(tx, { event: "INVITE_SENT", userId, actorId: adminId, email });
    return l;
  });
  return async () => (await sendLinkEmail(email, "INVITE", link, name))
    ? "An invite email with a link to set a password has been sent (valid 45 minutes)."
    : "The invite email could not be sent: use Send link again later, or set a temporary password.";
}

/** ADMIN, AUTH_MODE=app: a temporary password (the fallback when email fails). The user must change it at the next sign-in. */
export async function setTemporaryPasswordAction(userId: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction("setTemporaryPassword", async () => {
    // Only the app's own sign-in can end sessions and force the change at the next sign-in.
    if (authMode() !== "app") throw new AppError("Temporary passwords are set from Supabase Auth while AUTH_MODE=supabase.");
    // Exactly as typed (not trimmed): the person signs in with the same characters.
    const password = String(fd.get("password") ?? "");
    await actionTx(async (tx) => {
      const [p] = await tx<{ email: string; removed_at: Date | null }[]>`select email, removed_at from public.profiles where id = ${userId}`;
      if (!p || p.removed_at) throw new AppError("This person is not on the team.");
      const hash = await hashPassword(temporaryPassword(password, p.email));
      await asServer(tx, () => setPassword(tx, userId, hash, true));
    }, { roles: ["ADMIN"], reason: "Temporary password set by admin" });
    return "Temporary password set and the person signed out everywhere. Share it securely: they choose their own at the next sign-in.";
  });
}

/** ADMIN, AUTH_MODE=app: email a new invite / reset link (the old one stops working). */
export async function sendLinkAction(userId: string, _p: ActionResult | null): Promise<ActionResult> {
  return runAction("sendLink", async () => {
    if (authMode() !== "app") throw new AppError("Email links are not switched on.");
    if (!emailConfigured()) throw new AppError("Email is not set up on the server: set a temporary password instead.");
    const send = await actionTx(async (tx, actor) => {
      const [p] = await tx<{ email: string; full_name: string; removed_at: Date | null }[]>`
        select email, full_name, removed_at from public.profiles where id = ${userId}`;
      if (!p || p.removed_at) throw new AppError("This person is not on the team.");
      return inviteInTx(tx, actor.id, userId, p.email, p.full_name);
    }, { roles: ["ADMIN"] });
    return send();
  });
}
