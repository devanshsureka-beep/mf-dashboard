import "server-only";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

function publicConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not configured.");
  }
  return { url, anonKey };
}

/** Supabase client bound to the request cookies (the signed-in user's session). */
export async function createSupabaseServerClient() {
  const { url, anonKey } = publicConfig();
  const cookieStore = await cookies();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try {
          toSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a Server Component: cookies are refreshed by proxy.ts instead.
        }
      },
    },
  });
}

/**
 * Service-role client (bypasses RLS and storage policies). SERVER ONLY.
 * Use exclusively for storage (after the app's own access check), admin user
 * management in AUTH_MODE=supabase, integration endpoints and seeding.
 */
export function createSupabaseAdminClient() {
  // AUTH_MODE=app needs no public Supabase keys: storage reads the URL server-side (SUPABASE_URL).
  const url = process.env.SUPABASE_URL || publicConfig().url;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured (server only).");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
