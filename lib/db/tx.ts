import type postgres from "postgres";
import { getSql, type Sql } from "./client";

/** A transaction handle. Every service function receives one of these. */
export type Tx = postgres.TransactionSql<Record<string, never>>;

export type AppRole = "ADMIN" | "ADVISOR" | "OPERATIONS";

/** The authenticated staff member performing an action. */
export interface Actor {
  id: string;
  email: string;
  fullName: string;
  role: AppRole;
  /** AUTH_MODE=app: an admin set a temporary password; pages send the user to change it first. */
  mustChangePassword?: boolean;
}

/**
 * Optional `search_path` for every transaction (DB_SEARCH_PATH, e.g. "public, app").
 * Unset keeps the database default. Note: queries and database functions name their
 * schema explicitly (`public.`, `app.`), so this does not move them to another schema.
 */
function searchPath(): string {
  return process.env.DB_SEARCH_PATH?.trim() ?? "";
}

interface TxOptions {
  /** Free-text reason recorded in audit_logs for every change in this transaction. */
  reason?: string;
  sql?: Sql;
}

/**
 * Run `fn` in a transaction AS THE GIVEN USER with Row Level Security enforced.
 *
 * Mirrors what Supabase's Data API does per request: switches to the
 * `authenticated` role and exposes the verified JWT claims so `auth.uid()`
 * works inside policies and triggers. All statements commit or roll back
 * together.
 *
 * `userId` MUST come from a verified session (lib/auth/session.ts: Supabase Auth or the
 * app's own session, per AUTH_MODE);
 * never from request input.
 */
export async function withUserTx<T>(
  user: { id: string; email?: string },
  fn: (tx: Tx) => Promise<T>,
  opts: TxOptions = {},
): Promise<T> {
  const sql = opts.sql ?? getSql();
  const claims = JSON.stringify({ sub: user.id, role: "authenticated", email: user.email ?? null });
  return (await sql.begin(async (tx) => {
    await tx`
      select
        set_config('request.jwt.claims', ${claims}, true),
        set_config('request.jwt.claim.sub', ${user.id}, true),
        set_config('role', 'authenticated', true),
        set_config('app.audit_reason', ${opts.reason ?? ""}, true),
        set_config('app.actor_label', '', true)
    `;
    if (searchPath()) await tx`select set_config('search_path', ${searchPath()}, true)`;
    return fn(tx as unknown as Tx);
  })) as T;
}

/**
 * Run `fn` in a transaction as the trusted server: the connection's own role
 * (`postgres`, owner of the tables, so RLS does not apply). Business-rule
 * triggers and the audit trail still apply.
 *
 * ONLY for integration endpoints (after API-key verification), the seed script
 * and background jobs. `label` is written to audit_logs.actor_label.
 */
export async function withSystemTx<T>(
  label: string,
  fn: (tx: Tx) => Promise<T>,
  opts: TxOptions = {},
): Promise<T> {
  const sql = opts.sql ?? getSql();
  return (await sql.begin(async (tx) => {
    await tx`
      select
        set_config('request.jwt.claims', '', true),
        set_config('app.audit_reason', ${opts.reason ?? ""}, true),
        set_config('app.actor_label', ${label}, true)
    `;
    if (searchPath()) await tx`select set_config('search_path', ${searchPath()}, true)`;
    return fn(tx as unknown as Tx);
  })) as T;
}

/** Set / replace the audit reason for the remainder of the transaction. */
export async function setAuditReason(tx: Tx, reason: string | null | undefined): Promise<void> {
  await tx`select set_config('app.audit_reason', ${reason ?? ""}, true)`;
}

/**
 * Inside a user transaction, run `fn` as the connection's own role (the owner),
 * e.g. an admin's change to auth.users, which the `authenticated` role cannot
 * write. The claims stay set, so audit rows still name the admin. Use only after
 * the caller's role was checked (actionTx with roles: ["ADMIN"]).
 */
export async function asServer<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
  await tx`select set_config('role', session_user::text, true)`;
  const out = await fn();
  await tx`select set_config('role', 'authenticated', true)`;
  return out;
}
