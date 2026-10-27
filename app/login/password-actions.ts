"use server";

import { redirect } from "next/navigation";
import { after } from "next/server";
import { z } from "zod";
import { runAction, type ActionResult } from "@/lib/actions";
import { AppError } from "@/lib/errors";
import { withSystemTx } from "@/lib/db/tx";
import { authMode } from "@/lib/auth/mode";
import { requestMeta, startSession } from "@/lib/auth/app-session";
import { createLink, sendLinkEmail } from "@/lib/auth/links";
import { hashPassword, passwordProblem, verifyPassword } from "@/lib/auth/password";
import { requireActorForAction } from "@/lib/auth/session";
import { tokenHash } from "@/lib/auth/tokens";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { auditAuth, consumeLinkToken, findLoginUser, setPassword } from "@/services/auth-users";

const SENT = "If this email belongs to an account, a link to reset the password has been sent. It works once and expires in 45 minutes.";

function newPasswordFrom(fd: FormData, email?: string): string {
  const password = String(fd.get("new_password") ?? "");
  if (password !== String(fd.get("confirm_password") ?? "")) throw new AppError("The two new passwords do not match.");
  const problem = passwordProblem(password, email);
  if (problem) throw new AppError(problem);
  return password;
}

/** Signed-in user: change the password (also the forced change after a temporary one). Other sessions end. */
export async function changePasswordAction(_p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  let mustRedirect = false;
  const res = await runAction("changePassword", async () => {
    const actor = await requireActorForAction(undefined, { passwordChange: true });
    const current = String(fd.get("current_password") ?? "");
    const next = newPasswordFrom(fd, actor.email);
    if (next === current) throw new AppError("Choose a password different from the current one.");
    if (authMode() === "supabase") {
      const supabase = await createSupabaseServerClient();
      const check = await supabase.auth.signInWithPassword({ email: actor.email, password: current });
      if (check.error) throw new AppError("The current password is not right.");
      const { error } = await supabase.auth.updateUser({ password: next });
      if (error) throw new AppError(`Could not change the password: ${error.message}`);
      return "Password changed.";
    }
    const { ip } = await requestMeta();
    const hash = await hashPassword(next);
    await withSystemTx("auth:password", async (tx) => {
      const user = await findLoginUser(tx, actor.email);
      if (!user || user.id !== actor.id || !(await verifyPassword(current, user.encrypted_password))) throw new AppError("The current password is not right.");
      await setPassword(tx, actor.id, hash, false);
      await auditAuth(tx, { event: "PASSWORD_CHANGED", userId: actor.id, ip });
    });
    // setPassword ended every session, this one too: a fresh one keeps this browser signed in.
    await startSession(actor.id);
    mustRedirect = Boolean(actor.mustChangePassword);
    return "Password changed. Other devices were signed out.";
  });
  if (res.ok && mustRedirect) redirect("/");
  return res;
}

/** Forgot password (AUTH_MODE=app): the same answer whether or not the email exists, and whether or not the email went out. */
export async function requestResetAction(_p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const email = z.email().safeParse(String(fd.get("email") ?? "").trim().toLowerCase());
  if (!email.success) return { ok: false, error: "Enter a valid email." };
  if (authMode() !== "app") return { ok: false, error: "Password reset by email is not switched on. Ask an admin to set a temporary password." };
  const { ip } = await requestMeta();
  try {
    const out = await withSystemTx("auth:reset", async (tx) => {
      const user = await findLoginUser(tx, email.data);
      if (!user || user.blocked) return null;
      // At most 3 reset emails per account per hour.
      const [{ n }] = await tx<{ n: number }[]>`
        select count(*)::int as n from app.auth_tokens where user_id = ${user.id} and purpose = 'RESET' and created_at > now() - interval '1 hour'`;
      if (n >= 3) return null;
      const link = await createLink(tx, user.id, "RESET");
      await auditAuth(tx, { event: "PASSWORD_RESET_SENT", userId: user.id, email: email.data, ip });
      return { link, email: user.email };
    });
    // Sent after the answer, so the answer time does not tell whether the account exists.
    if (out) after(() => sendLinkEmail(out.email, "RESET", out.link).then(() => undefined));
  } catch {
    // Logged by the email helper or the database; the answer stays the same.
  }
  return { ok: true, message: SENT };
}

/** The link from a reset or invite email: set the password, use the link up, sign out everywhere. */
export async function resetPasswordAction(token: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const res = await runAction("resetPassword", async () => {
    if (authMode() !== "app") throw new AppError("Password links are not switched on.");
    if (!token || token.length > 100) throw new AppError("This link is not valid. Ask for a new one.");
    const password = String(fd.get("new_password") ?? "");
    if (password !== String(fd.get("confirm_password") ?? "")) throw new AppError("The two passwords do not match.");
    const hash = await hashPassword(password);
    const { ip } = await requestMeta();
    await withSystemTx("auth:reset", async (tx) => {
      const t = await consumeLinkToken(tx, tokenHash(token));
      if (!t) throw new AppError("This link has expired or was already used. Ask for a new one.");
      const [u] = await tx<{ email: string }[]>`select email from auth.users where id = ${t.user_id}`;
      // An account removed or banned since the link was sent cannot set a password.
      if (!u || (await findLoginUser(tx, u.email))?.blocked) throw new AppError("This link has expired or was already used. Ask for a new one.");
      const problem = passwordProblem(password, u?.email);
      if (problem) throw new AppError(problem);
      await setPassword(tx, t.user_id, hash, false);
      await auditAuth(tx, { event: "PASSWORD_RESET", userId: t.user_id, ip, note: t.purpose === "INVITE" ? "invite accepted" : undefined });
    });
    return "done";
  });
  if (res.ok) redirect("/login?password=set");
  return res;
}
