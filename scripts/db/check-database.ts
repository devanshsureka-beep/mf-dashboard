/**
 * Read-only check of a PostgreSQL database for this app (e.g. Cloud SQL after the move):
 * the roles, the auth schema, the app's own tables, and whether the app's login user can do what
 * the app does. Reads structure and COUNTS only (no names, emails or client data), in a
 * read-only transaction. Usage: DATABASE_URL=... npm run db:check
 */
import { createSql } from "@/lib/db/client";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* use real env */
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}
const sql = createSql(url, 1);
let fails = 0;
const out = (kind: "PASS" | "WARN" | "FAIL", msg: string) => {
  if (kind === "FAIL") fails++;
  console.log(`${kind}  ${msg}`);
};
const check = (ok: boolean, msg: string, hint = "") => out(ok ? "PASS" : "FAIL", ok ? msg : `${msg}${hint ? `  → ${hint}` : ""}`);

async function main() {
  await sql.begin("read only", async (tx) => {
    const [v] = await tx<{ v: string; u: string; su: boolean; db: string }[]>`
      select current_setting('server_version') as v, current_user as u, (select rolsuper from pg_roles where rolname = current_user) as su, current_database() as db`;
    console.log(`Database ${v.db}, PostgreSQL ${v.v}, connected as ${v.u}${v.su ? " (superuser)" : ""}\n`);

    const roles = await tx<{ rolname: string }[]>`select rolname from pg_roles where rolname in ('authenticated', 'service_role', 'anon')`;
    const have = new Set(roles.map((r) => r.rolname));
    for (const r of ["authenticated", "service_role", "anon"]) check(have.has(r), `role ${r} exists`, "run scripts/db/cloudsql-bootstrap.sql");
    if (have.has("authenticated")) {
      const [m] = await tx<{ ok: boolean }[]>`select pg_has_role(current_user, 'authenticated', 'SET') as ok`;
      check(m.ok || v.su, `${v.u} can SET ROLE authenticated (every user request does)`, `grant authenticated to ${v.u}`);
    }

    const [a] = await tx<{ users: boolean; ident: boolean; uid: boolean; storage: boolean }[]>`
      select to_regclass('auth.users') is not null as users, to_regclass('auth.identities') is not null as ident,
             to_regprocedure('auth.uid()') is not null as uid, to_regclass('storage.objects') is not null as storage`;
    check(a.users, "table auth.users exists", "run scripts/db/cloudsql-bootstrap.sql");
    check(a.ident, "table auth.identities exists", "run scripts/db/cloudsql-bootstrap.sql");
    check(a.uid, "function auth.uid() exists (row-level security needs it)", "run scripts/db/cloudsql-bootstrap.sql");
    check(a.storage, "storage.objects exists (migration 0010 policies refer to it)", "run scripts/db/cloudsql-bootstrap.sql");

    // From the catalog (pg_attribute), which shows columns whatever the login user may read.
    const colsOf = async (table: string) =>
      (await tx<{ attname: string }[]>`select attname from pg_attribute where attrelid = ${table}::regclass and attnum > 0 and not attisdropped`).map((x) => x.attname);
    if (a.users) {
      const cols = await colsOf("auth.users");
      const want = ["id", "email", "encrypted_password", "banned_until", "deleted_at", "raw_app_meta_data", "raw_user_meta_data", "email_confirmed_at", "last_sign_in_at", "instance_id", "aud", "role", "created_at", "updated_at"];
      const missing = want.filter((c) => !cols.includes(c));
      check(missing.length === 0, "auth.users has the columns the app uses", `missing: ${missing.join(", ")}`);
      const [can] = await tx<{ ok: boolean }[]>`select has_table_privilege('auth.users', 'select') as ok`;
      if (can.ok) {
        const [u] = await tx<{ n: number; pw: number; bcrypt: number }[]>`
          select count(*)::int as n, count(encrypted_password)::int as pw, count(*) filter (where encrypted_password like '$2%')::int as bcrypt from auth.users where deleted_at is null`;
        console.log(`      users: ${u.n}, with a password: ${u.pw}, bcrypt hashes: ${u.bcrypt}`);
        check(u.pw === u.bcrypt, "every stored password is a bcrypt hash (the app only reads bcrypt)", "other formats cannot sign in");
      }
    }

    const t = await tx<{ name: string; ok: boolean }[]>`
      select n as name, to_regclass(n) is not null as ok from unnest(array['public.profiles','public.clients','public.audit_logs','app.sessions','app.login_attempts','app.auth_tokens']) as n`;
    for (const x of t) check(x.ok, `table ${x.name} exists`, x.name.startsWith("app.") ? "apply migrations 0052 and 0053" : "apply the migrations");
    check((await colsOf("public.profiles")).includes("must_change_password"), "profiles.must_change_password exists (migration 0052)", "apply migration 0052");

    const [r] = await tx<{ total: number; rls: number }[]>`
      select count(*)::int as total, count(*) filter (where c.relrowsecurity)::int as rls
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'`;
    console.log(`      public tables: ${r.total}, with row-level security on: ${r.rls}`);
    check(r.total === 0 || r.rls >= r.total - 5, "row-level security is on for (almost) every public table", "the migrations enable it; a partial restore may have dropped it");

    // Can the login user do what the app does?
    const priv = await tx<{ what: string; ok: boolean }[]>`
      select * from (values
        ('read auth.users', case when to_regclass('auth.users') is null then false else has_table_privilege('auth.users', 'select') end),
        ('write auth.users (admin actions)', case when to_regclass('auth.users') is null then false else has_table_privilege('auth.users', 'update') and has_table_privilege('auth.users', 'insert') end),
        ('write auth.identities', case when to_regclass('auth.identities') is null then false else has_table_privilege('auth.identities', 'insert') end),
        ('use app.sessions', case when to_regclass('app.sessions') is null then false else has_table_privilege('app.sessions', 'select, insert, update, delete') end),
        ('use app.login_attempts', case when to_regclass('app.login_attempts') is null then false else has_table_privilege('app.login_attempts', 'select, insert, delete') end),
        ('use app.auth_tokens', case when to_regclass('app.auth_tokens') is null then false else has_table_privilege('app.auth_tokens', 'select, insert, update') end),
        ('write public.profiles', has_table_privilege('public.profiles', 'update')),
        ('write public.audit_logs', has_table_privilege('public.audit_logs', 'insert'))
      ) as p(what, ok)`;
    for (const p of priv) check(p.ok, `${v.u} can ${p.what}`, `own the tables (run migrations as ${v.u}) or grant it`);

    const [own] = await tx<{ owners: string }[]>`
      select coalesce(string_agg(distinct pg_get_userbyid(c.relowner), ', '), '-') as owners
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'app') and c.relkind = 'r'`;
    console.log(`      table owners: ${own.owners}`);
    // Row-level security helpers (app.user_role(), app.can_access_client() ...) are SECURITY DEFINER:
    // they run as their owner. If that owner is not the table owner (and not a superuser / BYPASSRLS
    // role) they read the tables WITH row-level security and see nothing, so every user sees an empty app.
    const [fn] = await tx<{ n: number; names: string | null }[]>`
      select count(*)::int as n, string_agg(p.proname, ', ') as names
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      join pg_class t on t.oid = 'public.profiles'::regclass
      join pg_roles fo on fo.oid = p.proowner
      where n.nspname = 'app' and p.prosecdef and p.proowner <> t.relowner and not fo.rolsuper and not fo.rolbypassrls`;
    check(fn.n === 0, "security-definer functions are owned by the tables' owner", `${fn.n} are not (${(fn.names ?? "").slice(0, 120)}): run scripts/db/cloudsql-own-objects.sql`);

    // Who is on the team (counts only).
    // Only the table's owner sees all rows (row-level security hides them from any other login).
    const [canProfiles] = await tx<{ ok: boolean }[]>`
      select has_table_privilege('public.profiles', 'select') and (pg_get_userbyid(c.relowner) = current_user or r.rolsuper) as ok
      from pg_class c, pg_roles r where c.oid = 'public.profiles'::regclass and r.rolname = current_user`;
    if (!canProfiles.ok) out("WARN", "team profile counts skipped (this login does not own public.profiles, so row-level security hides the rows)");
    if (canProfiles.ok) {
      const [p] = await tx<{ n: number; admins: number; active: number }[]>`
        select count(*)::int as n, count(*) filter (where role = 'ADMIN' and is_active)::int as admins, count(*) filter (where is_active)::int as active from public.profiles`;
      console.log(`      team profiles: ${p.n}, active: ${p.active}, active admins: ${p.admins}`);
      check(p.admins > 0, "at least one active admin can sign in and add the team", "create one with scripts (see docs/CLOUDSQL.md)");
    }
  });
  console.log(`\n${fails === 0 ? "Everything the app needs is in place." : `${fails} problem(s) above.`}`);
  await sql.end();
  process.exit(fails === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("Could not run the check:", e instanceof Error ? e.message : e);
  await sql.end().catch(() => {});
  process.exit(2);
});
