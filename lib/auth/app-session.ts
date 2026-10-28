import "server-only";
import { cookies, headers } from "next/headers";
import { withSystemTx } from "@/lib/db/tx";
import { clientIp } from "@/lib/auth/client-ip";
import { SESSION_COOKIE } from "@/lib/auth/mode";
import { newToken, tokenHash } from "@/lib/auth/tokens";
import { deleteSession, insertSession, SESSION_MAX_HOURS, sessionUser, type SessionUser } from "@/services/auth-users";

/**
 * AUTH_MODE=app sessions: a random token in an httpOnly cookie, its hash in
 * app.sessions. Expiry (SESSION_MAX_HOURS) and idle timeout (SESSION_IDLE_HOURS)
 * are checked in the database on every request.
 */

export async function requestMeta(): Promise<{ ip: string | null; userAgent: string | null }> {
  const h = await headers();
  // Only the entries our own load balancer / proxy appended are trusted (see lib/auth/client-ip.ts).
  const ip = clientIp(h.get("x-forwarded-for"), Number(process.env.TRUSTED_PROXY_ENTRIES));
  return { ip, userAgent: h.get("user-agent")?.slice(0, 200) ?? null };
}

const cookieOptions = (maxAgeSeconds: number) => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: maxAgeSeconds,
});

/** A fresh session (a new token at every sign-in) and its cookie. */
export async function startSession(userId: string): Promise<void> {
  const token = newToken();
  const { ip, userAgent } = await requestMeta();
  await withSystemTx("auth:sign-in", (tx) => insertSession(tx, { tokenHash: tokenHash(token), userId, ip, userAgent }));
  (await cookies()).set(SESSION_COOKIE, token, cookieOptions(SESSION_MAX_HOURS * 3600));
}

/** The signed-in user of this request, or null. */
export async function currentSessionUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token || token.length > 100) return null;
  return withSystemTx("auth:session", (tx) => sessionUser(tx, tokenHash(token)));
}

/** The hash of this request's session token (to keep this session when signing out the others). */
export async function currentTokenHash(): Promise<string | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? tokenHash(token) : null;
}

/** End this session: remove its row and the cookie. Returns the user it belonged to. */
export async function endSession(): Promise<string | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  store.set(SESSION_COOKIE, "", cookieOptions(0));
  if (!token || token.length > 100) return null;
  return withSystemTx("auth:sign-out", (tx) => deleteSession(tx, tokenHash(token)));
}
