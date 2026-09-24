import postgres from "postgres";

/**
 * Low-level Postgres connection pool (server only).
 *
 * Do NOT query with this directly from app code. Use `withUserTx` (RLS enforced
 * as the signed-in user) or `withSystemTx` (trusted server context such as
 * integration endpoints). See lib/db/tx.ts.
 */
type Sql = ReturnType<typeof postgres>;

const globalForDb = globalThis as unknown as { __mnSql?: Sql };

export function createSql(url: string, max = 5): Sql {
  return postgres(url, {
    // Supabase transaction pooler (port 6543) does not support prepared statements.
    prepare: false,
    max,
    idle_timeout: 20,
    connect_timeout: 15,
    onnotice: () => {},
    types: {
      // numeric -> number. Rupee amounts (2 dp) and units (4 dp) are well inside
      // IEEE-754 safe precision for this domain.
      numeric: {
        to: 1700,
        from: [1700],
        serialize: (v: unknown) => String(v),
        parse: (v: string) => Number(v),
      },
      // bigint (count(*)) -> number.
      bigint: {
        to: 20,
        from: [20],
        serialize: (v: unknown) => String(v),
        parse: (v: string) => Number(v),
      },
      // date -> 'YYYY-MM-DD' string (avoid timezone shifts of JS Date).
      date: {
        to: 1082,
        from: [1082],
        serialize: (v: unknown) => String(v),
        parse: (v: string) => v,
      },
    },
  });
}

export function getSql(): Sql {
  if (!globalForDb.__mnSql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not configured. See .env.example.");
    globalForDb.__mnSql = createSql(url);
  }
  return globalForDb.__mnSql;
}

export type { Sql };
