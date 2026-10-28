/**
 * Minimal migration runner for plain PostgreSQL (CI / Docker-less local).
 * For Supabase projects prefer the Supabase CLI: `supabase db push`.
 *
 * Applies supabase/migrations/*.sql in order, each in its own transaction, and
 * records them in supabase_migrations.schema_migrations (the same table the
 * Supabase CLI uses), so the two approaches stay compatible.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* use real env */
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
const dir = join(process.cwd(), "supabase", "migrations");

/**
 * `--baseline <version>`: for a database that was copied over already migrated (e.g. from Supabase to
 * Cloud SQL) and has no record of it. Records every migration up to that version as applied WITHOUT
 * running it. Never use it for a database that does not really have those migrations.
 */
const baselineArg = process.argv.indexOf("--baseline");
const baseline = baselineArg > 0 ? process.argv[baselineArg + 1] : null;

async function main() {
  await sql`create schema if not exists supabase_migrations`;
  await sql`create table if not exists supabase_migrations.schema_migrations (
    version text primary key, statements text[], name text)`;
  const applied = new Set((await sql<{ version: string }[]>`select version from supabase_migrations.schema_migrations`).map((r) => r.version));
  const files = readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();

  if (baseline) {
    if (!/^\d{14}$/.test(baseline)) throw new Error("--baseline needs a migration version, e.g. 20261107000051");
    if (applied.size > 0) throw new Error("This database already records migrations: --baseline is only for one that has none.");
    for (const f of files) {
      const [version, ...rest] = f.replace(/\.sql$/, "").split("_");
      if (version > baseline) continue;
      await sql`insert into supabase_migrations.schema_migrations (version, name, statements) values (${version}, ${rest.join("_")}, ${[`-- baseline: not run, the database already had it`]})`;
      applied.add(version);
    }
    console.log(`baseline recorded up to ${baseline} (${applied.size} migrations, none run)`);
  }

  // Already has data but no record of any migration: running migration 1 over it would fail or damage it.
  const [has] = await sql<{ yes: boolean }[]>`select to_regclass('public.clients') is not null as yes`;
  if (applied.size === 0 && has.yes) {
    throw new Error("This database already has the app's tables but records no migrations. Run with --baseline <last-applied-version> (see docs/CLOUDSQL.md); nothing was changed.");
  }
  for (const f of files) {
    const [version, ...rest] = f.replace(/\.sql$/, "").split("_");
    if (applied.has(version)) continue;
    const body = readFileSync(join(dir, f), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into supabase_migrations.schema_migrations (version, name, statements) values (${version}, ${rest.join("_")}, ${[body]})`;
    });
    console.log(`applied ${f}`);
  }
  console.log("migrations up to date");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
