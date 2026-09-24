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
 * `userId` MUST come from a verified Supabase session (lib/auth/session.ts);
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
    return fn(tx as unknown as Tx);
  })) as T;
}

/** Set / replace the audit reason for the remainder of the transaction. */
export async function setAuditReason(tx: Tx, reason: string | null | undefined): Promise<void> {
  await tx`select set_config('app.audit_reason', ${reason ?? ""}, true)`;
}
