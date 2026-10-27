"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { withSystemTx, withUserTx } from "@/lib/db/tx";
import type { ActionResult } from "@/lib/actions";
import { authMode } from "@/lib/auth/mode";
import { endSession, requestMeta, startSession } from "@/lib/auth/app-session";
import { verifyPassword } from "@/lib/auth/password";
import { assertSessionSecret } from "@/lib/auth/tokens";
import { auditAuth, findLoginUser, LOCK_MINUTES, lockAccountForSignIn, recordAttempt, signInLocked } from "@/services/auth-users";

const schema = z.object({ email: z.email(), password: z.string().min(1).max(200) });
const WRONG = "Invalid email or password.";

export async function signIn(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const parsed = schema.safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) return { ok: false, error: "Enter a valid email and password." };
  if (authMode() === "app") return signInApp(parsed.data.email.trim().toLowerCase(), parsed.data.password);

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword(parsed.data);
  // Generic message: do not reveal whether the account exists.
  if (error) return { ok: false, error: WRONG };
  // Admins (the manager's seat) land on Overview; advisors and operations on Today. The role is
  // read from the profile, as everywhere else (never from the token).
  let home = "/";
  if (data.user) {
    const [p] = await withUserTx({ id: data.user.id, email: data.user.email ?? "" }, (tx) =>
      tx<{ role: string }[]>`select role from public.profiles where id = ${data.user.id}`);
    if (p?.role === "ADMIN") home = "/overview";
  }
  redirect(home);
}

/**
 * AUTH_MODE=app: the account is looked up by email and the password checked with
 * bcrypt against auth.users. The same message for an unknown email, a wrong
 * password or a blocked account; too many wrong passwords lock the account for a
 * while (lib: signInLocked). Every password check is recorded, never the password.
 */
async function signInApp(email: string, password: string): Promise<ActionResult> {
  // A missing secret is a setup error: fail before any password is checked, not after.
  assertSessionSecret();
  const { ip } = await requestMeta();
  const outcome = await withSystemTx("auth:sign-in", async (tx) => {
    // Parallel attempts for one email wait for each other, so the count below is always current.
    await lockAccountForSignIn(tx, email);
    if (await signInLocked(tx, email, ip)) {
      // Not counted as a failure: a refused attempt must not extend the lock.
      await auditAuth(tx, { event: "SIGN_IN_LOCKED", userId: null, email, ip });
      return { ok: false as const, locked: true };
    }
    const user = await findLoginUser(tx, email);
    const good = await verifyPassword(password, user?.encrypted_password);
    if (!user || !good || user.blocked) {
      await recordAttempt(tx, email, ip, false);
      await auditAuth(tx, { event: "SIGN_IN_FAILED", userId: user?.id ?? null, email, ip, note: user?.blocked && good ? `account ${user.blocked.toLowerCase()}` : undefined });
      return { ok: false as const, locked: false };
    }
    await recordAttempt(tx, email, ip, true);
    await auditAuth(tx, { event: "SIGN_IN", userId: user.id, email, ip });
    return { ok: true as const, user };
  });
  if (!outcome.ok) {
    return { ok: false, error: outcome.locked ? `Too many attempts. Try again in ${LOCK_MINUTES} minutes, or reset your password.` : WRONG };
  }
  await startSession(outcome.user.id);
  redirect(outcome.user.must_change_password ? "/account/password" : outcome.user.role === "ADMIN" ? "/overview" : "/");
}

export async function signOut(): Promise<void> {
  if (authMode() === "app") {
    const userId = await endSession();
    if (userId) {
      const { ip } = await requestMeta();
      await withSystemTx("auth:sign-out", (tx) => auditAuth(tx, { event: "SIGN_OUT", userId, ip }));
    }
    redirect("/login");
  }
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}
