@AGENTS.md

# MN Advisory Dashboard — notes for AI assistants and developers

Read `README.md` and `docs/ARCHITECTURE.md` first. The core model is **Plan → Advice → Execution**. Never merge these concepts, and never compute the five transition numbers (Target / Advised / Executed / Pending / Yet to advise) outside the SQL views in `supabase/migrations/*_metrics_views.sql`.

## Conventions
- Schema changes: add a NEW file in `supabase/migrations/` (timestamp prefix). Never edit an applied migration.
- Status/type columns are TEXT + CHECK constraints; update the TypeScript unions in `types/domain.ts` together.
- Database access only through `withUserTx` (RLS, user requests) or `withSystemTx` (integrations/seed). Pages use `pageData()`, server actions use `actionTx()` from `lib/server.ts`.
- `services/*`: DB logic, take a `Tx`, no Next.js imports (so the seed script and tests can call them).
- `lib/domain/*`: pure logic with unit tests in `tests/unit`.
- Business rules belong in triggers (`*_business_rules.sql`) when they protect financial history; mirror friendly validation in services.
- Changes to financial records that need a reason: call `setAuditReason(tx, reason)` before the write.
- AI/extraction output must land as DRAFT plans / PENDING_REVIEW snapshots and pass zod contracts in `lib/integrations/contracts.ts`. The built-in deterministic parsers (`lib/parsers/*`) may auto-confirm a snapshot only when all their cross-checks pass; reconciliation auto-confirms only the clear transaction matches defined in `lib/domain/txn-matching.ts`.
- Never commit real client documents, names, PANs or folios, nor the CAS password template (it is the `CAS_PASSWORD_TEMPLATE` secret).
- Never log request bodies (CAS passwords, PII). Never expose server secrets with `NEXT_PUBLIC_`.

## Checks before committing
`npm run lint && npm run typecheck && npm test && npm run build`
DB tests need `TEST_DATABASE_URL` (see docs/LOCAL_WITHOUT_DOCKER.md or use `supabase start`).
