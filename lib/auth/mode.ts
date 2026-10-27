/**
 * Which sign-in the app uses. `supabase` (default): Supabase Auth, as before.
 * `app`: the app checks passwords and keeps its own sessions (lib/auth/app-session.ts).
 * Switching back is only this setting: users, ids and password hashes are shared.
 *
 * No "server-only" import: proxy.ts reads it too. Nothing secret here.
 */
export type AuthMode = "supabase" | "app";

export function authMode(): AuthMode {
  return process.env.AUTH_MODE === "app" ? "app" : "supabase";
}

/** The app-mode session cookie (holds a random token; the database keeps only its hash). */
export const SESSION_COOKIE = "mn_session";
