import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { withUserTx, type Actor, type AppRole } from "@/lib/db/tx";
import { AppError } from "@/lib/errors";

/**
 * Returns the signed-in, ACTIVE staff member or null.
 * The JWT is verified by Supabase (getClaims verifies the signature); the
 * profile (role) is loaded from the database, never from client input.
 */
export const getCurrentActor = cache(async (): Promise<Actor | null> => {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims?.sub) return null;

  const userId = data.claims.sub as string;
  const email = (data.claims.email as string | undefined) ?? "";

  const rows = await withUserTx({ id: userId, email }, (tx) => tx<
    { id: string; email: string; full_name: string; role: AppRole; is_active: boolean }[]
  >`select id, email, full_name, role, is_active from public.profiles where id = ${userId}`);

  const profile = rows[0];
  if (!profile || !profile.is_active) return null;
  return { id: profile.id, email: profile.email, fullName: profile.full_name, role: profile.role };
});

/** For pages: redirect to /login when not signed in; 403 page when role not allowed. */
export async function requireActor(roles?: AppRole[]): Promise<Actor> {
  const actor = await getCurrentActor();
  if (!actor) redirect("/login");
  if (roles && !roles.includes(actor.role)) redirect("/forbidden");
  return actor;
}

/** For server actions: throw (instead of redirect) so the form can show the error. */
export async function requireActorForAction(roles?: AppRole[]): Promise<Actor> {
  const actor = await getCurrentActor();
  if (!actor) throw new AppError("Your session has expired. Please sign in again.", "FORBIDDEN");
  if (roles && !roles.includes(actor.role)) {
    throw new AppError("Your role does not allow this action.", "FORBIDDEN");
  }
  return actor;
}

export const canAdvise = (a: Actor) => a.role === "ADMIN" || a.role === "ADVISOR";
export const isAdmin = (a: Actor) => a.role === "ADMIN";
