"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { withUserTx } from "@/lib/db/tx";
import type { ActionResult } from "@/lib/actions";

const schema = z.object({ email: z.email(), password: z.string().min(1) });

export async function signIn(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const parsed = schema.safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) return { ok: false, error: "Enter a valid email and password." };
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword(parsed.data);
  // Generic message: do not reveal whether the account exists.
  if (error) return { ok: false, error: "Invalid email or password." };
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

export async function signOut(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}
