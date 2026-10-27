import { randomUUID } from "node:crypto";
import type { AppRole, Tx } from "@/lib/db/tx";

/**
 * Accounts, sessions, sign-in limits and one-time links for AUTH_MODE=app.
 * Every function takes a SYSTEM transaction (withSystemTx): auth.users and the
 * app.* tables are not readable by the `authenticated` role. Callers hash
 * tokens and passwords (lib/auth/tokens.ts, lib/auth/password.ts); nothing
 * here sees a raw token. No Next.js imports (the seed and tests call these).
 */

// --- Accounts ----------------------------------------------------------------

export interface LoginUser {
  id: string;
  email: string;
  encrypted_password: string | null;
  /** Why this account may not sign in, or null. */
  blocked: "BANNED" | "DELETED" | "REMOVED" | "INACTIVE" | "NO_PROFILE" | null;
  role: AppRole | null;
  must_change_password: boolean;
}

export async function findLoginUser(tx: Tx, email: string): Promise<LoginUser | null> {
  const [u] = await tx<(Omit<LoginUser, "blocked"> & { banned: boolean; deleted: boolean; removed: boolean; is_active: boolean | null; has_profile: boolean })[]>`
    select u.id, u.email, u.encrypted_password,
      coalesce(u.banned_until > now(), false) as banned, u.deleted_at is not null as deleted,
      p.removed_at is not null as removed, p.is_active, p.id is not null as has_profile, p.role,
      coalesce(p.must_change_password, false) as must_change_password
    from auth.users u left join public.profiles p on p.id = u.id
    where lower(u.email) = lower(${email.trim()})
    order by u.created_at limit 1`;
  if (!u) return null;
  const blocked = u.deleted ? "DELETED" : u.banned ? "BANNED" : !u.has_profile ? "NO_PROFILE" : u.removed ? "REMOVED" : !u.is_active ? "INACTIVE" : null;
  return { id: u.id, email: u.email, encrypted_password: u.encrypted_password, blocked, role: u.role, must_change_password: u.must_change_password };
}

/**
 * A staff account, written the way Supabase Auth writes one (auth.users plus its
 * email identity), so AUTH_MODE=supabase can still sign this user in. The
 * `handle_new_auth_user` trigger reads mn_role / mn_full_name / mn_active from
 * raw_app_meta_data and creates the profile. GoTrue cannot read NULL in its
 * token columns, hence the empty strings.
 */
export async function createAuthUser(tx: Tx, a: {
  email: string; fullName: string; role: AppRole; passwordHash: string; mustChangePassword?: boolean; id?: string;
}): Promise<string> {
  const id = a.id ?? randomUUID();
  const email = a.email.trim().toLowerCase();
  await tx`
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change, email_change_token_current,
      phone_change, phone_change_token, reauthentication_token, is_sso_user, is_anonymous)
    values (
      '00000000-0000-0000-0000-000000000000', ${id}, 'authenticated', 'authenticated', ${email}, ${a.passwordHash}, now(),
      ${tx.json({ provider: "email", providers: ["email"], mn_role: a.role, mn_full_name: a.fullName, mn_active: true })},
      ${tx.json({ full_name: a.fullName })}, now(), now(),
      '', '', '', '', '', '', '', '', false, false)`;
  await tx`
    insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (${id}, ${id}, ${tx.json({ sub: id, email, email_verified: true, phone_verified: false })}, 'email', null, now(), now())`;
  await tx`
    update public.profiles set full_name = ${a.fullName}, role = ${a.role}, is_active = true,
      must_change_password = ${a.mustChangePassword ?? false}
    where id = ${id}`;
  return id;
}

export async function setPassword(tx: Tx, userId: string, passwordHash: string, mustChange: boolean): Promise<void> {
  await tx`update auth.users set encrypted_password = ${passwordHash}, updated_at = now() where id = ${userId}`;
  await tx`update public.profiles set must_change_password = ${mustChange} where id = ${userId}`;
  await revokeSessions(tx, userId);
}

/** Block or allow sign-in in both modes (Supabase Auth reads banned_until too). Blocking ends every session. */
export async function setSignInAllowed(tx: Tx, userId: string, allowed: boolean, meta: { role?: string; fullName?: string } = {}): Promise<void> {
  const extra = { mn_active: allowed, ...(meta.role ? { mn_role: meta.role } : {}), ...(meta.fullName ? { mn_full_name: meta.fullName } : {}) };
  await tx`
    update auth.users set banned_until = ${allowed ? null : tx`now() + interval '100 years'`},
      raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || ${tx.json(extra)}, updated_at = now()
    where id = ${userId}`;
  if (!allowed) await revokeSessions(tx, userId);
}

// --- Sessions ------------------------------------------------------------------

export const SESSION_MAX_HOURS = 7 * 24;
export const SESSION_IDLE_HOURS = 8;

export async function insertSession(tx: Tx, s: { tokenHash: string; userId: string; ip: string | null; userAgent: string | null }): Promise<void> {
  await tx`
    insert into app.sessions (token_hash, user_id, expires_at, ip, user_agent)
    values (${s.tokenHash}, ${s.userId}, now() + make_interval(hours => ${SESSION_MAX_HOURS}), ${s.ip}, ${s.userAgent})`;
  await tx`update auth.users set last_sign_in_at = now() where id = ${s.userId}`;
  // Housekeeping: expired sessions and month-old attempts.
  await tx`delete from app.sessions where expires_at < now() or last_seen_at < now() - make_interval(hours => ${SESSION_IDLE_HOURS})`;
  await tx`delete from app.login_attempts where at < now() - interval '30 days'`;
}

export interface SessionUser { id: string; email: string; full_name: string; role: AppRole; must_change_password: boolean }

/** The user of a live session, or null (expired, idle too long, or the account was blocked since). */
export async function sessionUser(tx: Tx, tokenHash: string): Promise<SessionUser | null> {
  const [s] = await tx<(SessionUser & { stale: boolean })[]>`
    select p.id, p.email, p.full_name, p.role, p.must_change_password, s.last_seen_at < now() - interval '1 minute' as stale
    from app.sessions s
    join auth.users u on u.id = s.user_id
    join public.profiles p on p.id = s.user_id
    where s.token_hash = ${tokenHash} and s.expires_at > now()
      and s.last_seen_at > now() - make_interval(hours => ${SESSION_IDLE_HOURS})
      and u.deleted_at is null and (u.banned_until is null or u.banned_until <= now())
      and p.is_active and p.removed_at is null`;
  if (!s) return null;
  if (s.stale) await tx`update app.sessions set last_seen_at = now() where token_hash = ${tokenHash}`;
  return { id: s.id, email: s.email, full_name: s.full_name, role: s.role, must_change_password: s.must_change_password };
}

export async function deleteSession(tx: Tx, tokenHash: string): Promise<string | null> {
  const [r] = await tx<{ user_id: string }[]>`delete from app.sessions where token_hash = ${tokenHash} returning user_id`;
  return r?.user_id ?? null;
}

/** Sign the user out everywhere (removed, role changed, password changed). */
export async function revokeSessions(tx: Tx, userId: string, keepTokenHash?: string): Promise<void> {
  await tx`delete from app.sessions where user_id = ${userId} and token_hash <> ${keepTokenHash ?? ""}`;
}

// --- Sign-in limits ------------------------------------------------------------

export const LOCK_MINUTES = 15;
const MAX_FAILS_PER_ACCOUNT = 5;
const MAX_FAILS_PER_IP = 30;

/** Too many recent failures for this email or from this IP: the sign-in is refused without checking the password. */
export async function signInLocked(tx: Tx, email: string, ip: string | null): Promise<boolean> {
  const [r] = await tx<{ by_email: number; by_ip: number }[]>`
    select
      (select count(*)::int from app.login_attempts where email = ${email.toLowerCase()} and not ok and at > now() - make_interval(mins => ${LOCK_MINUTES})
         and at > coalesce((select max(at) from app.login_attempts where email = ${email.toLowerCase()} and ok), '-infinity')) as by_email,
      (select count(*)::int from app.login_attempts where ip = ${ip ?? ""} and not ok and at > now() - make_interval(mins => ${LOCK_MINUTES})) as by_ip`;
  return r.by_email >= MAX_FAILS_PER_ACCOUNT || (ip !== null && r.by_ip >= MAX_FAILS_PER_IP);
}

export async function recordAttempt(tx: Tx, email: string, ip: string | null, ok: boolean): Promise<void> {
  await tx`insert into app.login_attempts (email, ip, ok) values (${email.toLowerCase().slice(0, 254)}, ${ip}, ${ok})`;
}

// --- One-time links (reset, invite) -------------------------------------------

export const LINK_MINUTES = 45;

export async function insertLinkToken(tx: Tx, userId: string, tokenHash: string, purpose: "RESET" | "INVITE"): Promise<void> {
  // A new link replaces older unused ones for the same purpose.
  await tx`update app.auth_tokens set used_at = now() where user_id = ${userId} and purpose = ${purpose} and used_at is null`;
  await tx`insert into app.auth_tokens (token_hash, user_id, purpose, expires_at) values (${tokenHash}, ${userId}, ${purpose}, now() + make_interval(mins => ${LINK_MINUTES}))`;
}

/** The link's user if it is unused and unexpired (does not use it up). */
export async function peekLinkToken(tx: Tx, tokenHash: string): Promise<{ user_id: string; purpose: "RESET" | "INVITE"; email: string } | null> {
  const [t] = await tx<{ user_id: string; purpose: "RESET" | "INVITE"; email: string }[]>`
    select t.user_id, t.purpose, u.email from app.auth_tokens t join auth.users u on u.id = t.user_id
    where t.token_hash = ${tokenHash} and t.used_at is null and t.expires_at > now()`;
  return t ?? null;
}

/** Use the link up (once): returns its user, or null when it was used, expired or never existed. */
export async function consumeLinkToken(tx: Tx, tokenHash: string): Promise<{ user_id: string; purpose: "RESET" | "INVITE" } | null> {
  const [t] = await tx<{ user_id: string; purpose: "RESET" | "INVITE" }[]>`
    update app.auth_tokens set used_at = now()
    where token_hash = ${tokenHash} and used_at is null and expires_at > now()
    returning user_id, purpose`;
  return t ?? null;
}

// --- Audit -----------------------------------------------------------------------

export type AuthEvent = "SIGN_IN" | "SIGN_IN_FAILED" | "SIGN_IN_LOCKED" | "SIGN_OUT" | "PASSWORD_CHANGED" | "PASSWORD_RESET_SENT" | "PASSWORD_RESET" | "INVITE_SENT";

/** A sign-in event in audit_logs. Never the password or a token. */
export async function auditAuth(tx: Tx, e: { event: AuthEvent; userId: string | null; actorId?: string | null; email?: string | null; ip?: string | null; note?: string }): Promise<void> {
  await tx`
    insert into public.audit_logs (actor_id, actor_label, entity_type, entity_id, action, new_value, reason)
    values (${e.actorId ?? e.userId}, 'auth', 'auth', ${e.userId}, ${e.event},
      ${tx.json({ email: e.email ?? null, ip: e.ip ?? null })}, ${e.note ?? null})`;
}
