# Security notes

This system stores sensitive financial data: holdings, PAN and client identities. The controls below are implemented. The checklist at the end must be completed for production.

## Implemented controls

**Authentication**
- Supabase Auth, email + password. Public sign-up must be disabled in the dashboard. As defence in depth, any new auth user gets an **inactive** profile unless created by an admin, and inactive users can access nothing (`app.user_role()` returns null).
- A user's role is read from `profiles` on every request and never taken from client input or user-editable metadata. Only `app_metadata` (writable only with the service-role key) seeds a new profile. A trigger stops non-admins from changing role, activation or email, including on their own profile.
- `proxy.ts` refreshes sessions and redirects signed-out users. Every page, action and route handler still checks authorisation itself.

**Authorisation (Row Level Security)**
- RLS is enabled on every table. `anon` has no grants.
- Access helpers (`app.can_access_client`, `can_advise_client`, `can_operate_client`) are `SECURITY DEFINER` with `search_path = ''`.
- ADVISOR sees assigned clients only. OPERATIONS sees all clients but cannot create plans or issue, revise or cancel advice (enforced by RLS), and may change only the status of SIP items (trigger). ADMIN manages users and assignments and sees the global audit log.
- Views are `security_invoker`, so RLS applies through them.
- Server code runs every user request as the `authenticated` role with that user's verified JWT claims (`lib/db/tx.ts`). The trusted `withSystemTx` path is used only after integration API-key verification and by the seed script.

**Integrity**
- Financial history is never hard-deleted (triggers), and cancellations and voids require reasons.
- `audit_logs` is append-only. Rows are written only by a `SECURITY DEFINER` trigger, and UPDATE, DELETE and TRUNCATE are blocked by trigger and revoked.
- All integration payloads pass zod validation before any write. Callbacks are idempotent.

**Files**
- The `client-documents` bucket is **private**, limited to 25 MB and to PDF / PNG / JPEG / JSON / CSV.
- Storage RLS scopes each object to the client ID in its path.
- Downloads use 60-second signed URLs generated with the *user's* session, after an RLS-checked lookup.
- Uploads are hashed (SHA-256) and de-duplicated. A PDF's magic bytes are checked. Objects are never overwritten (`upsert: false`).

**Secrets**
- `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, `INTEGRATION_API_KEY` and `N8N_WEBHOOK_TOKEN` are server-only (no `NEXT_PUBLIC_` prefix). Modules that use them import `server-only`.
- Integration keys are compared in constant time, and the API refuses to work when the key is missing or shorter than 24 characters.
- **CAS passwords are never persisted or logged.** The built-in reader builds candidates in memory from `CAS_PASSWORD_TEMPLATE` (a server-only secret) plus client mobile numbers, the file name, or a typed password/mobile. They are used only to open the PDF during that request. The optional n8n path passes a typed password once over HTTPS. Only a `password_protected` flag is stored. Server error logging records the context and the Postgres error code, never request bodies.
- Real client documents are never committed: parser tests use masked fixtures (`tests/fixtures/*`).

**Web**
- Security headers are set: `X-Frame-Options: DENY`, `nosniff`, HSTS, `Referrer-Policy` and `Permissions-Policy`. `X-Powered-By` is off, and pages are `noindex`.
- User-facing errors are sanitised (`lib/errors.ts`); SQL and stack traces are never shown.
- Server Actions carry Next.js's built-in origin check against CSRF.

## Production checklist

- [ ] Supabase Auth: **disable sign-ups**, enforce strong passwords, and enable MFA (TOTP) for all staff (Auth → MFA).
- [ ] Use the **transaction pooler** `DATABASE_URL` with a strong DB password, and rotate it if it is ever exposed.
- [ ] Set all secrets only in Vercel environment variables, separately for Preview and Production. Never share production keys with previews that run untrusted branches.
- [ ] Generate `INTEGRATION_API_KEY` and `N8N_WEBHOOK_TOKEN` with `openssl rand -hex 32`, and rotate them periodically.
- [ ] n8n: use HTTPS only, disable saving execution data for the CAS workflow (it carries passwords and PII), and restrict who can see executions.
- [ ] Supabase: enable Point-in-Time Recovery / backups. Keep the project in the Mumbai region for data residency.
- [ ] The Supabase Data API (PostgREST) remains protected by the same RLS. If you do not need it, remove `public` from *Exposed schemas* (Settings → API) to shrink the attack surface; the app does not use it.
- [ ] Review `audit_logs` access. Advisors can read the trail of their own clients; tighten `audit_logs_select` if needed.
- [ ] Never run `npm run seed` against production.
- [ ] Monitor failed CAS extractions and unadvised activity daily (Command Centre → Needs attention).
