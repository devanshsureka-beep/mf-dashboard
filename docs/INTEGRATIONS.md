# n8n integration contracts

The schemas live in `lib/integrations/contracts.ts` (zod) and are the single source of truth. The same schemas validate the n8n callbacks **and** the manual "import JSON" screens in the app.

## Authentication

| Direction | Mechanism |
|---|---|
| n8n → app | Header `Authorization: Bearer <INTEGRATION_API_KEY>` (in n8n: HTTP Request node → Authentication → Generic → Header Auth) |
| app → n8n | Header `Authorization: Bearer <N8N_WEBHOOK_TOKEN>` (in n8n: Webhook node → Authentication → Header Auth) |

Responses: `401` bad key · `422` validation failed, with `issues[]` · `404` unknown client or document · `409` duplicate · `201` created · `200` idempotent repeat. Nothing is written unless validation passes. Payloads are limited to 5 MB of JSON; uploads to 25 MB.

## 1. CAS extraction

### 1a. app → n8n: `N8N_CAS_PARSE_WEBHOOK_URL`

Sent when a CAS is uploaded (if the URL is configured) or when someone clicks *Send for extraction*.

```json
{
  "cas_document_id": "0f7c…",
  "client_code": "MN-00241",
  "client_name": "Client Name",
  "source": "CAMS",
  "file_url": "https://<project>.supabase.co/storage/v1/object/sign/client-documents/…?token=…",
  "file_url_expires_in_seconds": 600,
  "password": "only-if-the-user-typed-it-or-null",
  "callback_url": "https://your-app/api/integrations/cas-parse-result"
}
```

`password` exists only in this one request. The app never stores or logs it, and n8n must not persist it either (disable "Save execution data" for this workflow, or strip the field).

**Recommended workflow:** Webhook → HTTP Request (download `file_url`) → decrypt the PDF (e.g. a small `qpdf`/`pikepdf` service, or the Python `casparser` library, which parses CAMS/KFintech CAS deterministically) → *or* Claude with a strict JSON schema prompt → map to the contract below → HTTP Request `POST callback_url`. On any error, post the FAILED form.

### 1b. n8n → app: `POST /api/integrations/cas-parse-result`

```json
{
  "cas_document_id": "0f7c…",
  "status": "PARSED",
  "extraction_method": "AI_EXTRACTION",
  "statement": {
    "source": "CAMS",
    "statement_from_date": "1984-01-01",
    "statement_to_date": "2026-09-24",
    "valuation_date": "2026-09-23",
    "investor_name": "…",
    "investor_pan": "ABCDE1234F"
  },
  "holdings": [
    {
      "scheme_name": "Axis Gold and Silver Passive FoF - Regular Growth",
      "isin": "INF846K01XXX",
      "amc": "Axis",
      "folio_number": "914213726096/0",
      "plan_type": "REGULAR",
      "category": "Gold & silver FoF",
      "units": 38123.456,
      "nav": 11.4688,
      "nav_date": "2026-09-23",
      "current_value": 437226.00,
      "cost_value": 400000.00
    }
  ],
  "transactions": [
    { "date": "2025-12-29", "type": "PURCHASE", "scheme_name": "…", "isin": "…", "folio_number": "…",
      "units": 38123.456, "nav": 10.4924, "amount": 400000, "balance_units": 38123.456, "description": "Purchase" }
  ],
  "totals": { "current_value": 1577657, "invested_value": 1551257 },
  "warnings": ["Page 7 was partially unreadable"]
}
```

Failure form: `{ "cas_document_id": "…", "status": "FAILED", "error": "Incorrect PDF password" }`

Field rules:
- `holdings`: at least 1 line. `units` and `current_value` ≥ 0. `isin` must be 12 characters in ISIN format. `plan_type` is `DIRECT` or `REGULAR`.
- `transactions[].type` is one of: `PURCHASE, SIP, REDEMPTION, SWITCH_IN, SWITCH_OUT, DIVIDEND_PAYOUT, DIVIDEND_REINVESTMENT, BONUS, MERGER, STAMP_DUTY, STT, TDS, OTHER`. Use signed units (negative for redemptions / switch-outs). SIP instalments **must** use `SIP` so that reconciliation can explain SIP-driven increases.

What the app does:
1. Idempotency: if the CAS already has a snapshot, it returns it (`duplicate: true`).
2. Deterministic validation. Any of the following sets the CAS to `NEEDS_REVIEW` instead of `PARSED`:
   - the sum of holdings differs from `totals.current_value` by more than 0.5%
   - units × NAV differs from a line's value by more than 2%
   - an ISIN is missing
   - the statement PAN does not match the client's PAN
   - a snapshot with the same date and value already exists
3. Creates a **new** `PENDING_REVIEW` snapshot. Holdings resolve to `security_master` by ISIN, and a new ISIN creates a new entry. Transactions are de-duplicated against earlier statements.
4. A person reviews the snapshot and confirms it. The first confirmed snapshot becomes the baseline; every later confirmation automatically starts a reconciliation run.

Response: `201 {"ok":true,"status":"PARSED"|"NEEDS_REVIEW"|"FAILED","snapshotId":"…","duplicate":false,"warnings":[…]}`

### 1c. n8n → app: `POST /api/integrations/cas-upload` (multipart)

For workflows that *receive* CAS PDFs, e.g. an email inbox. Form fields: `file` (PDF), `client_code`, `source`, `password_protected` (`true`/`false`), `notes`, optionally `password` (forwarded once, not stored) and `trigger_parse=false` to skip extraction. Duplicate files (same SHA-256 for the client) return `409`.

## 2. Advisory report extraction → DRAFT plan

### 2a. app → n8n: `N8N_ADVISORY_PARSE_WEBHOOK_URL`

```json
{ "document_id": "…", "client_code": "MN-00241", "client_name": "…", "file_url": "…signed…",
  "file_url_expires_in_seconds": 600, "callback_url": "https://your-app/api/integrations/advisory-report-result" }
```

### 2b. n8n → app: `POST /api/integrations/advisory-report-result`

The shape follows a typical rebalancing report: the per-folio sell list, the buy list and the SIP table.

```json
{
  "client_code": "MN-00241",
  "document_id": "…",
  "status": "PARSED",
  "plan": { "plan_name": "Portfolio rebalancing & execution report", "plan_date": "2026-09-24",
            "starting_portfolio_value": 1577657, "notes": "Moderate risk · wealth creation" },
  "items": [
    { "action": "SELL",   "scheme_name": "Bandhan Silver ETF FoF (Reg)", "folio_number": "8111234/09",
      "current_amount": 188225, "target_amount": 188225, "reason": "Full exit", "priority": 10 },
    { "action": "SWITCH", "scheme_name": "Mahindra Manulife Multi Cap Fund (Reg)", "current_amount": 189295,
      "target_amount": 189295, "switch_to_scheme_name": "Mahindra Manulife Multi Cap Fund (Direct)" },
    { "action": "RETAIN", "scheme_name": "…", "current_amount": 100000, "target_amount": 0 },
    { "action": "BUY",    "scheme_name": "Edelweiss Mid Cap Fund - Direct Growth", "isin": "INF…",
      "target_amount": 202656.82, "target_weight": 12.8, "reason": "Core mid cap; balancing line" }
  ],
  "sip_items": [
    { "action": "STOP",  "scheme_name": "PGIM India Flexi Cap (Reg)", "old_amount": 2500, "debit_day": 8 },
    { "action": "START", "scheme_name": "Edelweiss Mid Cap Fund (Direct)", "new_amount": 2000, "frequency": "MONTHLY" }
  ],
  "declared_totals": { "exit_value": 1577656.82, "buy_value": 1577656.82, "sip_value": 7600 },
  "warnings": []
}
```

What the app does:
- Creates an **`AI_EXTRACTION` DRAFT plan**. It is never ACTIVE, whatever the payload says.
- Resolves each line to `security_master` by ISIN, or by an unambiguous, plan-type-aware name match. Anything uncertain gets `security_id = null` and `needs_review = true`. The database refuses approval until the advisor resolves those lines.
- Cross-checks `declared_totals` against the sum of the extracted lines and writes any discrepancies into the plan notes.
- Is idempotent per `document_id`.

## 3. Reconciliation trigger — `POST /api/integrations/reconciliation-trigger`

```json
{ "client_code": "MN-00241" }                       // latest confirmed snapshot vs previous
{ "client_id": "…", "current_snapshot_id": "…" }     // explicit
```

Returns `{"ok":true,"run_id":"…","existing":false}`. It only **proposes** matches; people decide.

## 4. Notifications

### 4a. app → n8n events: `N8N_NOTIFICATION_WEBHOOK_URL`

Fire-and-forget; failures never block the user action.

```json
{ "event": "cas.parsed", "occurred_at": "2026-09-24T05:12:00Z",
  "client": { "id": "…", "client_code": "MN-00241", "full_name": "…" },
  "actor": null, "data": { "cas_document_id": "…", "snapshot_id": "…", "status": "NEEDS_REVIEW", "warnings": 2 } }
```

Events: `cas.parsed`, `cas.failed`, `plan.draft_created`, `reconciliation.completed` (plus reserved `advice.*`, `execution.recorded`, `plan.approved`).

### 4b. n8n → app digest: `POST /api/integrations/notifications/digest`

Read-only. Use it from an n8n Schedule trigger (e.g. 18:00 IST) to send each advisor their pending calls:

```json
{ "ok": true, "generated_at": "…",
  "metrics": { "calls_issued_today": 6, "pending_value_total": 3699600, "unadvised_activity": 1, "…": "…" },
  "pending_by_advisor": [{ "advisor_name": "…", "open_calls": 7, "pending_amount": 2100000, "stale_calls": 2 }],
  "stale_calls": [{ "client_code": "MN-00106", "action": "SELL", "scheme_name": "…", "pending_amount": 800000, "age_days": 7 }] }
```

## 5. Testing without n8n

- **CAS:** upload the PDF on the client's *Upload CAS* page, then paste the extraction JSON (form 1b, without `cas_document_id`) on the CAS page.
- **Advisory report:** *Documents → Upload document → Import advisory report extraction (JSON)*.
- **With curl:**

```bash
curl -X POST "$APP/api/integrations/cas-parse-result" \
  -H "authorization: Bearer $INTEGRATION_API_KEY" -H "content-type: application/json" \
  -d @docs/examples/cas-parse-result.json
```

Example files: [`docs/examples/`](examples/).
