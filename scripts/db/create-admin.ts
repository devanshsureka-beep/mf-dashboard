/**
 * Create the first admin of a database (e.g. a fresh Cloud SQL database where no one can sign in yet).
 * Refuses an email that already has an account. The admin must choose their own password at the
 * first sign-in.
 *
 *   DATABASE_URL=... NEW_ADMIN_EMAIL=you@univest.in NEW_ADMIN_NAME="Your Name" NEW_ADMIN_PASSWORD=... npm run admin:create
 *
 * The password comes from the environment, never from the command line (shell history), and is
 * never printed or logged. After signing in, remove it from wherever you set it.
 */
import { hashPassword, passwordProblem } from "@/lib/auth/password";
import { createSql } from "@/lib/db/client";
import { withSystemTx } from "@/lib/db/tx";
import { createAuthUser } from "@/services/auth-users";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* use real env */
}

const { DATABASE_URL, NEW_ADMIN_EMAIL: email, NEW_ADMIN_NAME: name, NEW_ADMIN_PASSWORD: password } = process.env;
if (!DATABASE_URL || !email || !name || !password) {
  console.error("DATABASE_URL, NEW_ADMIN_EMAIL, NEW_ADMIN_NAME and NEW_ADMIN_PASSWORD are required.");
  process.exit(1);
}
const problem = passwordProblem(password, email);
if (problem) {
  console.error(`Password not accepted: ${problem}`);
  process.exit(1);
}

async function main() {
  const sql = createSql(DATABASE_URL!, 1);
  try {
    const hash = await hashPassword(password!);
    const id = await withSystemTx("create-admin", async (tx) => {
      await tx`select set_config('app.audit_reason', 'First admin created by script', true)`;
      const [exists] = await tx<{ n: number }[]>`select count(*)::int as n from auth.users where lower(email) = ${email!.trim().toLowerCase()}`;
      if (exists.n > 0) throw new Error("An account with this email already exists.");
      return createAuthUser(tx, { email: email!, fullName: name!.trim(), role: "ADMIN", passwordHash: hash, mustChangePassword: true });
    }, { sql });
    console.log(`Admin created (${id}). Sign in with this email and the password you set, then choose your own.`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

main();
