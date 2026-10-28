# Running on Cloud SQL (plain PostgreSQL), without Supabase for sign-in or access control

Supabase gave this app four things beyond a database. On plain PostgreSQL the app brings its own:

| Was Supabase's | Now |
|---|---|
| Sign-in and sessions | The app (`AUTH_MODE=app`): bcrypt against `auth.users`, sessions in `app.sessions` (`lib/auth`, `services/auth-users.ts`) |
| Who is signed in, for the database | The app sets `request.jwt.claims` and `role = authenticated` inside every transaction (`lib/db/tx.ts`); `auth.uid()` reads it |
| Roles `authenticated` / `service_role`, schema `auth`, `auth.uid()`, a `storage` stub | `scripts/db/cloudsql-bootstrap.sql` |
| Who owns the tables | The app's login user (`scripts/db/cloudsql-own-objects.sql`) |

Authorization itself was always ours: roles in `public.profiles`, checks in the app, row-level security in the migrations.
**File storage is still Supabase Storage** (`lib/storage.ts`) until it moves to Google Cloud Storage.

## One-time setup of an already-migrated database

Do these on the real database only after the same steps worked on an empty test database (see the end).

1. **Network.** Do not leave a public IP open to the world. Use the Cloud SQL Auth Proxy or a private IP, or restrict "authorized networks" to the app's addresses. Require SSL on the instance, and use `?sslmode=require` in `DATABASE_URL`.
2. **Secrets.** `DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DB?sslmode=require` goes into the app's secret store (Secret Manager), never into code or chat. Rotate any password that was ever pasted in a chat or ticket.
3. **Roles and `auth`.** As an admin user, run `scripts/db/cloudsql-bootstrap.sql` (edit the app user name on the first lines if it is not `mf_app_user`). It only adds what is missing.
4. **Ownership.** If the database was migrated by another user (e.g. `postgres`), run `scripts/db/cloudsql-own-objects.sql` as an admin. The row-level-security helper functions must be owned by the same user as the tables, or every user sees an empty app.
5. **Migration record.** The copy has no record of which migrations it has. Record them without running them, then apply the new ones, as the app user:
   `DATABASE_URL=... npm run db:migrate -- --baseline 20261107000051`
   (0051 is the last migration production had.) This applies 0052 onwards: the sign-in tables, the profile guard and the client-delete guard. Without `--baseline` the runner refuses to touch a database that has data and no record.
6. **Check.** `DATABASE_URL=... npm run db:check` is read-only (structure and counts, no names or client data). Fix every FAIL it lists.
7. **First admin**, if the users did not come across (the check shows "active admins: 0"):
   `NEW_ADMIN_EMAIL=... NEW_ADMIN_NAME="..." NEW_ADMIN_PASSWORD=... DATABASE_URL=... npm run admin:create`
   The password is read from the environment, never printed, and must be changed at the first sign-in. Existing users keep their bcrypt passwords if `auth.users` was copied.
8. **App settings.** `AUTH_MODE=app`, `SESSION_SECRET` (`openssl rand -hex 32`), and `TRUSTED_PROXY_ENTRIES`:
   - behind the Google Cloud external HTTP(S) load balancer: `2` (it sends `<client>, <load-balancer>`);
   - behind a single proxy that appends the client address: `1`;
   - unset: no client IP is recorded and only the per-account lockout applies. Never set it higher than the number of proxies you control.

## Testing

- Never run the demo seed, the browser test or the database tests against a database that holds real clients. The seed now refuses one with any non-demo client.
- Use an empty test database on the same instance: run steps 3, 5 (without `--baseline`: it runs every migration), 4 if needed, 6, then `npm run seed`.
- Database tests (`TEST_DATABASE_URL`) run as the app login, except two whose fixtures need an admin login (`set session_replication_role`): `tests/db/full-redemption.test.ts` and `tests/db/migrate-to-direct.test.ts`.

## Things that were Supabase-only and are now handled

- Migration 0054 replaces a hard-coded `postgres` / `service_role` user name in the client-delete guard with "is a signed-in user acting?" (the rule every other guard already uses).
- The server's own transactions (`withSystemTx`) run as the app login user. It must be able to read and write `auth.users`, `auth.identities`, `app.sessions`, `app.login_attempts` and `app.auth_tokens`: `npm run db:check` verifies exactly that.
- `service_role` exists only because grants name it; the app never switches to it, so it needs no BYPASSRLS (Cloud SQL does not hand that out).
