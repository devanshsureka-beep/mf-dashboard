import bcrypt from "bcryptjs";

/**
 * Passwords are bcrypt, cost 10: the same format Supabase Auth writes into
 * auth.users.encrypted_password, so either sign-in can check a hash the other
 * wrote. Do not switch to another algorithm while AUTH_MODE=supabase must
 * remain a working rollback. No Next.js imports (the seed and tests use it).
 */
const COST = 10;

export const hashPassword = (password: string): Promise<string> => bcrypt.hash(password, COST);

export async function verifyPassword(password: string, hash: string | null | undefined): Promise<boolean> {
  // Unknown account or no password: still spend the time of one check, so the
  // answer time does not tell whether the email exists.
  if (!hash || !hash.startsWith("$2")) {
    await bcrypt.compare(password, DUMMY_HASH);
    return false;
  }
  return bcrypt.compare(password, hash);
}

const DUMMY_HASH = "$2b$10$SeCyWqfvzPdv3HOrPgC4FOrPpWUF9TsOu.F2Idvq55UxsEusD8.rq";

export const PASSWORD_MIN = 12;

/** Why a new password is not accepted, or null. */
export function passwordProblem(password: string, email?: string): string | null {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > 72) return "Use at most 72 characters."; // bcrypt reads only the first 72 bytes
  const local = email?.split("@")[0].toLowerCase() ?? "";
  // Only a name long enough to matter (a short address like ra@ would rule out too much).
  if (local.length >= 4 && password.toLowerCase().includes(local)) return "Do not use your email in the password.";
  return null;
}
