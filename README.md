# MN Advisory Dashboard

Internal web application for investment-advisory operations. It tracks the full advisory lifecycle of every client:

```
CAS onboarding → portfolio snapshot → advisory plan (end state)
      → individual BUY / SELL / SWITCH calls issued over time
      → client executions (partial fills supported)
      → next CAS → reconciliation (confirm / reject / unadvised)
      → pending actions + immutable audit history
```

For every client and every plan line the app always shows five separate numbers:

| Number | Meaning |
|---|---|
| **Target** | What the approved plan says should ultimately be sold / bought |
| **Advised** | What was actually communicated to the client (calls) |
| **Executed** | What the client actually did (confirmed executions) |
| **Pending execution** | Advised − Executed |
| **Yet to advise** | Target − Advised |

Example (from the demo data, client *Arjun Malhotra*, ₹1 Cr): Target exit ₹42L · Advised ₹25L · Executed ₹18L · Pending ₹7L · Yet to advise ₹17L.

---

## Contents

1. [Architecture](#architecture)
2. [Project structure](#project-structure)
3. [Create the Supabase project](#create-the-supabase-project)
4. [Environment variables](#environment-variables)
5. [Run locally](#run-locally)
6. [Migrations](#migrations)
7. [Demo seed data](#demo-seed-data)
8. [Tests and checks](#tests-and-checks)
9. [Deploy on Vercel](#deploy-on-vercel)
10. [n8n integration](#n8n-integration)
11. [Database model](#database-model)
12. [Business rules](#business-rules)
13. [Security](#security)

Deeper documentation: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) · [`docs/SECURITY.md`](docs/SECURITY.md) · [`docs/LOCAL_WITHOUT_DOCKER.md`](docs/LOCAL_WITHOUT_DOCKER.md)

---

## Architecture

| Layer | Technology | Notes |
|---|---|---|
| UI | Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4, shadcn-style components | Server Components render data; Server Actions perform mutations |
| Auth | Supabase Auth (email + password, sign-up disabled) | Session cookie refreshed by `proxy.ts` |
| Data | Supabase PostgreSQL | **Source of truth.** Business rules enforced by triggers; metrics computed by SQL views |
| Access control | Postgres Row Level Security | Every request runs as the signed-in user (`authenticated` role + verified JWT claims) |
| Files | Supabase Storage, private bucket `client-documents` | 60-second signed URLs, SHA-256 de-duplication |
| Automation | n8n via authenticated webhooks | Extraction (CAS / advisory report), notifications, reconciliation trigger |
| AI | Claude (called from n8n) | Only *proposes* data: every extraction is validated and lands as DRAFT / PENDING_REVIEW |

**Key design decision — transactions with RLS.** Server code talks to Postgres directly (`postgres` driver through the Supabase connection pooler). It does not use the PostgREST Data API. Each request runs in one transaction that switches to the `authenticated` role with the user's verified JWT claims, exactly as PostgREST would, so RLS applies. The difference is that multi-step operations become atomic: issuing a batch of calls, revising a call, confirming a reconciliation match. They also carry an audit reason. See `lib/db/tx.ts`.

```
Browser ──► Next.js (Vercel)
              ├─ proxy.ts ............ session refresh / redirect to /login
              ├─ Server Components ... pageData(): requireActor → withUserTx (RLS)
              ├─ Server Actions ...... actionTx(): requireActorForAction → withUserTx (RLS, 1 transaction)
              └─ /api/integrations/* . Bearer INTEGRATION_API_KEY → zod validation → withSystemTx
                         │
                         ▼
              Supabase Postgres (tables + triggers + views + RLS)   Supabase Storage (private)
                         ▲
              n8n ───────┘  (CAS/report extraction with Claude, notifications, schedules)
```

## Project structure

```
app/
  (app)/                    authenticated pages
    page.tsx                Command Centre
    clients/                Clients list, new client, Client 360 (tabs), plans, CAS upload, documents
    advice/                 Call ledger, issue call, call detail (revise / cancel / executions)
    executions/pending/     Pending executions
    reconciliation/         Runs, run review (confirm / partial / reject / unadvised)
    cas/[casId]/            CAS document status, trigger extraction, manual JSON import
    snapshots/[id]/         Snapshot review (confirm / reject), diff vs previous
    audit/                  Global audit log (admin)
    admin/users/            Staff users, roles, assignments (admin)
  api/integrations/         n8n endpoints (see docs/INTEGRATIONS.md)
  api/documents/[id]/       Signed-URL download (RLS-checked)
  login/                    Sign in
components/ui/              Button, Card, Badge, Table, form fields (shadcn-style)
components/app/             Domain components (transition summary, tables, forms)
lib/
  db/                       Postgres pool + withUserTx / withSystemTx
  domain/                   Pure business logic (reconciliation engine, advice rules, fund-name matching)
  integrations/             Contracts (zod), n8n client, API-key auth
  auth/, supabase/, storage.ts, format.ts, errors.ts, actions.ts, server.ts
services/                   Database logic per domain (clients, portfolio, plans, advice, executions, reconciliation, …)
types/domain.ts             Shared TypeScript types
supabase/migrations/        SQL migrations (tables, triggers, views, RLS, storage)
supabase/local-harness/     Docker-less local stack helpers (dev only)
scripts/seed/               Demo data (runs through the real services)
scripts/db/migrate.ts       Migration runner for plain Postgres / CI
tests/unit/                 Pure logic tests
tests/db/                   Database integration tests (rolled back, RLS + triggers)
docs/                       Architecture, integrations, security, local setup
```

## Create the Supabase project

1. Create a project at <https://supabase.com/dashboard> (region: `ap-south-1` Mumbai recommended).
2. **Authentication → Providers → Email:** keep Email enabled, **disable "Allow new users to sign up"**. Staff accounts are created by an admin inside the app (or by the seed script).
3. **Authentication → URL configuration:** set *Site URL* to your app URL (e.g. `https://mn-advisory.vercel.app`).
4. Apply the migrations (next sections). They create every table, trigger, view, RLS policy and the private storage bucket. Do not create anything by hand.
5. Collect the credentials listed below.

## Environment variables

Copy `.env.example` to `.env.local` (local) or set them in Vercel → Project → Settings → Environment Variables. Never commit real values.

| Variable | Where to find it | Exposure |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API → Project URL | public |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Project Settings → API Keys → `anon` / publishable key | public (RLS protects data) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API Keys → `service_role` / secret key | **server only** |
| `DATABASE_URL` | Supabase → Connect → **Transaction pooler** URI (port 6543), with the DB password | **server only** |
| `APP_BASE_URL` | Your deployed URL (used in n8n callback URLs) | server |
| `INTEGRATION_API_KEY` | Generate: `openssl rand -hex 32`. Put the same value in n8n's header auth | **server only** |
| `N8N_CAS_PARSE_WEBHOOK_URL` | n8n Webhook node URL of your CAS extraction workflow (optional) | server |
| `N8N_ADVISORY_PARSE_WEBHOOK_URL` | n8n Webhook URL of your advisory-report extraction workflow (optional) | server |
| `N8N_NOTIFICATION_WEBHOOK_URL` | n8n Webhook URL receiving business events (optional) | server |
| `N8N_WEBHOOK_TOKEN` | Token the app sends to n8n webhooks as `Authorization: Bearer …` | **server only** |
| `SEED_DEMO_PASSWORD` | Any strong password, only for demo users created by `npm run seed` | dev only |

## Run locally

Prerequisites: Node.js ≥ 20.9, npm, and either **Docker + Supabase CLI** (recommended) or the Docker-less harness.

```bash
npm install

# Option A — Supabase CLI (Docker)
npx supabase start          # prints local API URL, anon key, service_role key, DB URL
npx supabase db reset       # applies supabase/migrations
cp .env.example .env.local  # fill in the values printed by `supabase start`
                            # DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
npm run seed                # demo users + 10 clients
npm run dev                 # http://localhost:3000

# Option B — no Docker: see docs/LOCAL_WITHOUT_DOCKER.md
```

Sign in with any demo user (password = `SEED_DEMO_PASSWORD`):

| Role | Email |
|---|---|
| ADMIN | `admin.demo@example.com` |
| ADVISOR | `rohan.mehta@example.com`, `priya.iyer@example.com`, `karan.shah@example.com` |
| OPERATIONS | `neha.verma@example.com` |

## Migrations

All schema changes live in `supabase/migrations/` (timestamped, applied in order):

| File | Contents |
|---|---|
| `…0001_foundation.sql` | `app` helper schema, profiles, role helpers, auth-user trigger |
| `…0002_clients_securities_documents.sql` | clients (MN-xxxxx IDs), assignments, access helpers, security master, documents |
| `…0003_portfolio.sql` | CAS documents, snapshots, holdings, transactions (de-duplicated) |
| `…0004_advisory_plans.sql` | advisory plans, plan items, SIP plan items |
| `…0005_advice_executions.sql` | advice batches, advice items, executions |
| `…0006_reconciliation_notes_audit.sql` | reconciliation runs / matches, client notes, append-only audit log |
| `…0007_business_rules.sql` | audit triggers, immutability guards, status derivation, reason enforcement |
| `…0008_metrics_views.sql` | Target / Advised / Executed / Pending / Yet-to-advise views, Command Centre function |
| `…0009_rls.sql` | grants + Row Level Security policies |
| `…0010_storage.sql` | private `client-documents` bucket + storage policies |

Apply them with either:

```bash
npx supabase link --project-ref <ref> && npx supabase db push   # Supabase CLI (recommended)
npm run db:migrate                                              # plain Postgres / CI (uses DATABASE_URL)
```

Both record applied versions in `supabase_migrations.schema_migrations`, so they are interchangeable. To change the schema, add a **new** migration file. Never edit one that has already been applied to production.

## Demo seed data

`npm run seed` creates 5 staff users (1 admin, 3 advisors, 1 operations) and 10 fictional clients. It goes through the same service functions as the UI, running as each user under RLS, so seeding also exercises the business rules. Scenarios included:

- **₹1 Cr client**: target exit ₹42L, advised ₹25L, executed ₹18L, pending ₹7L, yet to advise ₹17L. Also a revised call (₹5L → ₹2L), a cancelled call, multiple partial executions, BUY side, and SIP stop/start progress.
- **CAS reconciliation example**: a unit-based SELL matched with HIGH confidence, a manual execution awaiting CAS verification, SIP instalments, and one **unadvised** reduction.
- Today's calls and executions, stale pending calls (> 3 days), a unit-based call filled 200 + 300 units, an AI-extracted DRAFT plan with lines needing review, a CAS in NEEDS_REVIEW, a completed transition, a dormant client with an overdue review, and a prospect.

The seed refuses to run twice (reset the database to reseed) and refuses to run with `NODE_ENV=production`. Demo ISINs use the obviously fake `INFDM…` range.

## Tests and checks

```bash
npm run lint        # ESLint
npm run typecheck   # next typegen + tsc
npm test            # vitest: unit tests + DB integration tests (if TEST_DATABASE_URL is set)
npm run build       # production build
npm run verify      # all of the above
```

DB integration tests (`tests/db`) need `TEST_DATABASE_URL` (e.g. in `.env.test.local`) pointing at a database with the migrations applied. Each scenario runs in a transaction that is **always rolled back**. They cover:
- target − advised = yet to advise, and advised − executed = pending
- partial executions, including multiple executions per call and multiple calls per plan item
- cancelled and revised calls, and no negative remainders
- unit-based calls
- immutability and mandatory reasons
- RLS isolation between roles
- AI drafts that cannot be activated
- reconciliation confirm without double counting, and unadvised activity

## Deploy on Vercel

1. Push this repository to GitHub and import it in Vercel (framework: Next.js; defaults are fine).
2. Add all environment variables above (Production + Preview). Use the **transaction pooler** `DATABASE_URL` (port 6543).
3. Apply migrations to the production database (`supabase db push`) **before** the first deploy.
4. Deploy. Create the first admin (only needed once):
   - Supabase → Authentication → Users → *Add user* (email + password, auto-confirm), then in the SQL editor:
     `update public.profiles set role = 'ADMIN', is_active = true, full_name = 'Your Name' where email = 'you@firm.in';`
   - After that, create every other user from **Users & Access** inside the app.
5. Do **not** run the demo seed in production.

## n8n integration

The app exposes validated, authenticated endpoints. n8n workflows do the document work (decrypt the CAS, call Claude, map to the contract) and post back. The full contracts, example payloads and recommended workflows are in [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md).

| Direction | Endpoint / webhook | Purpose |
|---|---|---|
| n8n → app | `POST /api/integrations/cas-upload` | Push a CAS PDF (e.g. from an inbox) for a client |
| app → n8n | `N8N_CAS_PARSE_WEBHOOK_URL` | Ask n8n to extract a CAS (signed file URL, optional one-time password) |
| n8n → app | `POST /api/integrations/cas-parse-result` | Extraction result → new PENDING_REVIEW snapshot (idempotent) |
| app → n8n | `N8N_ADVISORY_PARSE_WEBHOOK_URL` | Ask n8n to extract an advisory report |
| n8n → app | `POST /api/integrations/advisory-report-result` | Extraction → **DRAFT** plan (never ACTIVE) |
| n8n → app | `POST /api/integrations/reconciliation-trigger` | Re-run reconciliation for a client |
| n8n → app | `POST /api/integrations/notifications/digest` | Daily digest data (pending calls by advisor, today's metrics) |
| app → n8n | `N8N_NOTIFICATION_WEBHOOK_URL` | Business events (`cas.parsed`, `plan.draft_created`, …) |

All inbound calls require `Authorization: Bearer <INTEGRATION_API_KEY>`. Nothing is written until the payload passes validation. Every extraction can also be imported manually as JSON from the UI, which works with no n8n at all.

## Database model

```
profiles ─┬─< client_advisor_assignments >── clients (MN-xxxxx)
          │                                     │
          │        ┌────────────────────────────┼──────────────────────────────┐
          │        │                            │                              │
          │   documents ──1:1── cas_documents ──1:1── portfolio_snapshots ─< portfolio_holdings
          │                                     │            │               (immutable once reviewed)
          │                                     │            └─< portfolio_transactions (deduped)
          │                                     │
          │   advisory_plans ─< advisory_plan_items          sip_plan_items >─ advisory_plans
          │         (DRAFT→ACTIVE→COMPLETED/REPLACED/CANCELLED)
          │                         ▲ plan_item_id (optional = off-plan call)
          └── advice_batches ─< advice_items ─< executions
               (one communication)   (one call; REVISED chain)   (partial fills)
                                        ▲
          reconciliation_runs ─< reconciliation_matches (SUGGESTED / CONFIRMED / PARTIAL / REJECTED / UNEXPLAINED)
          security_master (ISIN-keyed)        client_notes        audit_logs (append-only, trigger-written)
```

Key views: `v_advice_items`, `v_plan_item_progress`, `v_plan_transition`, `v_client_summary`, `v_pending_executions`, `v_latest_snapshot`, `v_snapshot_change`, `v_sip_summary`, plus the function `command_centre_metrics(date)`. Full column-level detail and the counting rules are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Business rules

These are enforced **in the database**, so they hold for every code path, including the UI, the integrations and the SQL console:

1. **Plan is not advice.** Plans only move DRAFT → ACTIVE through explicit approval, and approval never issues a call.
2. **Advice is not execution.** An advice item's status (ISSUED / PARTIALLY_EXECUTED / EXECUTED) is *derived* from executions by trigger.
3. **The CAS is evidence.** Each CAS makes a new snapshot, which starts PENDING_REVIEW. Holdings are immutable once reviewed, and metrics use only CONFIRMED snapshots.
4. **History never disappears.** Deletes are blocked on financial tables. Cancellations, revisions and voided executions are status changes with mandatory reasons. `audit_logs` is append-only.
5. **AI output needs validation.** Extractions land as PENDING_REVIEW snapshots or DRAFT plans. Uncertain security matches are flagged `needs_review`, and plans cannot be approved until those are resolved.
6. **No automatic matching.** Reconciliation only *suggests*; a CAS_VERIFIED execution exists only after a person confirms a match.
7. **Everything is timestamped.** `communicated_at` and `created_at` are immutable, and the audit log records who, when, old, new and why.
8. **Five numbers, always.** They come from the SQL views, never from front-end arithmetic.
9. **Partial execution** is supported at every level: many executions per call, many calls per plan item.
10. **Snapshots are never overwritten.** Duplicate CAS files (same SHA-256) are rejected, and duplicate callbacks are idempotent.

Counting rules (per call): pending = advised − executed while the call is open. A cancelled, expired or revised call counts only what was executed before it closed. A revision's replacement carries *new total − already executed*. A fully executed call counts exactly what was executed, so a small NAV shortfall returns to "yet to advise". Amount-based calls close within a 1% tolerance, and unit-based calls close when the units are reached.

## Security

Summary (details and a production checklist in [`docs/SECURITY.md`](docs/SECURITY.md)):
- Supabase Auth with public sign-up disabled; new auth users are inactive until an admin activates them.
- RLS on every table: advisors see assigned clients; operations cannot create plans or issue or alter advice; only admins see the global audit log and manage users.
- Private storage bucket, 60-second signed URLs, and per-client storage policies.
- The service-role key, database URL and integration keys are server-only (never `NEXT_PUBLIC_`).
- **CAS passwords are never stored or logged.** A password is passed once, in memory, to the extraction webhook.
- Security headers, generic error messages (no SQL or stack traces in the browser), and constant-time API-key comparison.
