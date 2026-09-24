import "server-only";
import { notFound } from "next/navigation";
import { requireActor, requireActorForAction } from "@/lib/auth/session";
import { withUserTx, type Actor, type AppRole, type Tx } from "@/lib/db/tx";
import { AppError } from "@/lib/errors";

/**
 * For Server Components: authenticate, then run queries as that user with RLS.
 * Missing / inaccessible records render the 404 page.
 */
export async function pageData<T>(fn: (tx: Tx, actor: Actor) => Promise<T>, roles?: AppRole[]): Promise<T & { actor: Actor }> {
  const actor = await requireActor(roles);
  try {
    const data = await withUserTx(actor, (tx) => fn(tx, actor));
    return { ...data, actor };
  } catch (e) {
    if (e instanceof AppError && e.code === "NOT_FOUND") notFound();
    throw e;
  }
}

/** For Server Actions: authenticate (throwing), then run in ONE transaction with RLS. */
export async function actionTx<T>(
  fn: (tx: Tx, actor: Actor) => Promise<T>,
  opts: { roles?: AppRole[]; reason?: string } = {},
): Promise<T> {
  const actor = await requireActorForAction(opts.roles);
  return withUserTx(actor, (tx) => fn(tx, actor), { reason: opts.reason });
}

export const ADVISORY_ROLES: AppRole[] = ["ADMIN", "ADVISOR"];
export const ALL_ROLES: AppRole[] = ["ADMIN", "ADVISOR", "OPERATIONS"];
