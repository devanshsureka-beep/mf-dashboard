# Architecture & data model

## 1. Principles

- **PostgreSQL is the source of truth.** AI and automation only *propose* data (extractions, match suggestions). Every financial state change is either deterministic (triggers, views) or confirmed by a person.
- **Rules live in the database.** Immutability, status derivation, mandatory reasons, no-delete and audit are triggers. RLS enforces roles. The UI and the integrations cannot bypass them.
- **Metrics come from views.** Target / Advised / Executed / Pending / Yet-to-advise are computed once, in `supabase/migrations/…0008_metrics_views.sql`, and read everywhere.
- **Small, separable modules.** `services/*` hold database logic per domain and take a transaction handle (`Tx`). `lib/domain/*` holds pure logic with unit tests. Pages and actions stay thin.

## 2. Request flow

| Entry point | Auth | DB access |
|---|---|---|
| Server Component page | `requireActor()` (Supabase JWT verified via `getClaims`, role loaded from `profiles`) | `pageData()` → `withUserTx` (role `authenticated`, JWT claims set → RLS) |
| Server Action | `requireActorForAction()` | `actionTx()` → one transaction, optional audit reason |
| `/api/integrations/*` | `Authorization: Bearer INTEGRATION_API_KEY` (constant-time) | zod validation → `withSystemTx(label)` (table owner, triggers + audit still apply, `actor_label` recorded) |
| `/api/documents/[id]/download` | session | RLS lookup → 60 s signed URL generated with the user's session (storage RLS applies) |

`app.audit_reason` and `app.actor_label` are transaction-local settings read by the audit trigger.

## 3. Architectural issues identified in the specification, and how they are resolved

| # | Issue | Resolution |
|---|---|---|
| 1 | **SIP actions appear twice** (plan item actions `STOP_SIP/START_SIP` and a separate `sip_plan_items` table). Two homes for the same fact would drift. | SIP actions live only in `sip_plan_items`. The enum values remain for completeness but are excluded from lump-sum maths. |
| 2 | **SWITCH has two legs.** Counting it on both sides double-counts. | `SWITCH` counts on the SELL side (switch-out). The switch-in is a separate `BUY` item, exactly as advisory reports present it. |
| 3 | **Revising a partly executed call.** Moving executions would rewrite history; keeping the full new amount would double-count. | The original becomes `REVISED` and keeps its executions. The replacement carries *new total − already executed*. A REVISED or CANCELLED call counts only its executed part. |
| 4 | **NAV drift.** A ₹3L sell redeems ₹2,98,900, so a call would never reach 100% and would stay "pending" forever. | Amount calls close within a 1% tolerance, and unit calls close on units. A closed call counts exactly what was executed, so the tiny shortfall returns to "yet to advise" and pending never shows phantom amounts. |
| 5 | **Unit vs amount calls** ("SELL 500 units"). Rupee roll-ups need a rupee figure. | `quantity_basis` decides completion. `advised_amount` is always present (the estimate for unit calls), so roll-ups stay in rupees. |
| 6 | **Double counting between manual executions and CAS.** The advisor records "client confirmed ₹1L", then the next CAS shows the same purchase. | Reconciliation expects *pending + manually recorded but not CAS-verified* quantity. Confirming a match first **verifies** existing executions (`cas_verified_at`) and only creates a new `CAS_VERIFIED` execution for the remainder. |
| 7 | **Overlapping CAS statements** repeat the same transactions. | `portfolio_transactions.dedupe_hash` is unique per client. |
| 8 | **SIP instalments look like "unadvised" purchases.** | Increases explained by `SIP` transactions in the CAS window are classified `SIP_INSTALMENT` rather than UNADVISED. |
| 9 | **AI extraction trust.** | Snapshots start `PENDING_REVIEW` and plans start `DRAFT`. Security matches are only accepted by ISIN or an unambiguous name, otherwise `needs_review`, which blocks approval. Declared report totals are cross-checked against extracted lines. |
| 10 | **Security identity.** Regular and Direct plans are different securities, and names are messy. | `security_master` is keyed by ISIN. Reconciliation aggregates by security across folios. Plan-type-aware name matching gives suggestions only. |
| 11 | **"Today" is ambiguous** on UTC servers. | Every "today" metric uses IST (`app.today_ist()`). |
| 12 | **CAS passwords.** | Never stored. A password is passed once, in memory, to the extraction webhook; only a `password_protected` flag is kept. |
| 13 | **Active plan edits** must not silently change history, but plans do evolve. | Amending an ACTIVE plan requires a reason (enforced by trigger). `approved_target_*` values are frozen at approval, and current targets show amendments. A wholesale re-plan is a new plan: the old one becomes `REPLACED`. |
| 14 | **PostgREST cannot run multi-step business operations atomically.** | Server-side transactions with RLS (`withUserTx`). |
| 15 | **Holdings diffs cannot tell *when* a call was executed**, and cannot separate two trades in the same fund. | A detailed CAS carries every transaction. Reconciliation engine **v2** (`lib/domain/txn-matching.ts`) matches each *new* CAS transaction (first seen in this snapshot) to calls. The rules: same security/ISIN, same direction (SELL ↔ redemption / switch-out, BUY ↔ purchase / switch-in), call date (IST) ≤ transaction date, oldest call first, 3% tolerance. Clear matches (≤ 30 days) are auto-confirmed, and the execution gets the exact CAS date, amount, units and NAV. Engine v1 (holdings diff) remains for statements without transactions. A row that moved units is matched by what it is, even when its wording mentions a tax ("Redemption … less STT"); rows stored before a reader fix are re-read from their description (`effectiveTxnType`). **Re-check** on a run matches the CAS transactions it has no row for yet, leaving existing rows untouched. |
| 16 | **Name-only securities.** Funds to buy come from the report without an ISIN. | They are created ISIN-less. The first CAS that holds the fund attaches its ISIN to that entry (confident, same-plan-type name match only), so calls on it match CAS transactions. |
| 17 | **SIP plan actions** need evidence too. | A SIP instalment on or after the advice/approval date completes a START (or CHANGE at the new amount), and a "SIP Cancelled" row completes a STOP. SIP instalments never satisfy lump-sum calls. |
| 18 | **Deterministic document reading, zero tolerance for silent mistakes.** | `lib/pdf/text.ts` (pdf.js) → `lib/parsers/cas.ts` (KFintech/CAMS consolidated) and `lib/parsers/advisory-report.ts` (Univest template). Table rows are recognised by the shape of their cells (folio, ₹ amount, "—", change word), not by column position, because long text wraps into extra cells. Every table is cross-checked against an independent part of the report: printed totals, headline figures, the fund-wise review verdicts (EXIT / TRIM ₹X / HOLD / ADD ₹X / SWITCH) and the SIP routing panel. `lib/domain/report-plan.ts` then ties every line to the CAS: folio, fund, Direct/Regular, value (±0.2%), the same valuation date, and every CAS holding covered by a verdict. **Any** mismatch blocks onboarding with a numbered list, and nothing is saved. Tamper tests in `tests/unit/parsers.test.ts` prove each check fires. |
| 19 | **Report value vs value today.** The report is a picture of one day; NAVs move every day. | Two views per client. *At onboarding* is the baseline CAS (the one the report was checked against), and it never changes. *Current* is units from the latest confirmed CAS × the latest NAV from the daily AMFI feed (`mf_schemes`, `v_holding_live`). A later CAS only changes units (what was executed, plus anything the client did on their own). |
| 20 | **Money left after calls.** | `v_client_cash`: executed SELL proceeds − executed BUY amounts (switches move money fund-to-fund and are excluded). Shown per client and used to filter clients for one call to many (`/advice/bulk`). Each client still gets their own batch, linked to their plan item for that fund and side when there is one. |
| 21 | **SIPs are not listed in a CAS.** | `lib/domain/sip-status.ts` reads them from the transactions: lines marked systematic / SIP, or ≥ 3 purchases of the same amount about a month apart (broker and platform SIPs appear as plain purchases). Several SIPs in one folio are added up. A SIP is running if an instalment fell in the last 40 days. Previous CAS vs latest CAS gives started / stopped / amount changed, checked against the plan's SIP changes. |
| 22 | **Operations onboard clients** but cannot create clients or plans under RLS. | Only the onboarding flow (fully cross-checked, deterministic) runs as the trusted server for OPERATIONS, labelled `onboarding:<email>` in the audit log. The plan stays a DRAFT that an advisor or admin approves. |
| 23 | **Fresh money after onboarding.** A client adds money later and gets a report for that amount only; one ACTIVE plan per client. | The report is an *additional investment* (`advisory_plans.plan_kind = 'ADDITIONAL'`, chosen on upload or auto-detected for a client with an active plan). Only its own lines must tie to the CAS, and buys − sells must equal the fresh money. Approving it does not replace the plan: its lines are copied into the ACTIVE plan with `tranche_plan_id`, the fresh money goes to `client_fresh_money`, and the draft becomes `MERGED`. The five numbers cover both tranches; money left = fresh money + sells − buys. |
| 24 | **Migrate to Direct.** Reports move Regular holdings to the Direct plan of the same fund; that is neither a sell nor a buy. | A plan line of its own (`MIGRATE`, with `switch_to_security_id`) outside the lump-sum targets and money left. `v_migration_progress` is the checklist (To do / Switch call issued / Done / Done (seen in CAS: no Regular units left, Direct units held)). SWITCH calls may be linked to MIGRATE lines; the plan page issues them in one batch for the ticked funds (the Regular units of that line's folio when the CAS shows them). In CAS matching the switch-out matches the call (calls on the trade's own folio first) and the switch-in to the target is the other leg of the switch, not an unadvised purchase. |
| 25 | **Recording mistakes in calls and executions.** Calls and executions are immutable for everyone else. | An ADMIN may correct a call (amount, units, basis, NAV, fund, plan line, date, channel) or an execution (amount, units, date, NAV) in place, always with a reason (`services/corrections.ts`). The database allows it only for an admin with `app.audit_reason` set (`app.admin_correction()`, migration 0016); the audit log keeps old and new values, and the call's status is re-derived. Identity columns, CAS verification links and terminal statuses stay protected. |
| 26 | **SIP next to lump sums.** Last-moment changes move money between a lump-sum buy and a SIP. | SIP has its own transition (`v_client_sip`): monthly target / advised / started / yet to advise, and *invested so far* = SIP instalments seen in CAS since each line was advised (`v_sip_item_progress`), never a projection. Invested under the plan = lump-sum buys executed + SIP invested. A BUY line's not-yet-advised part can become a SIP START line (monthly amount entered by the advisor), and a SIP line not yet started can become a lump-sum BUY line (`services/sip.ts`), each with a reason. |
| 27 | **Everything about a client, for reviews and audits.** | `client_agreements` (what was signed, validity, signed copy as a client document), `client_payments` (MF Premium paid: amount, date, period covered, mode, reference; admin-only corrections and refunds, never deleted) and `v_client_premium` (paid until, renewal due, agreement status), migration 0017. The client page shows them in its header with an attention strip (unadvised trades to review, CAS to check, draft plan, follow-ups, premium, agreement), SIP / Agreements & premium / Monthly reports tabs, and a Timeline of every recorded event since onboarding (`getTimeline`). |
| 28 | **Monthly client report.** | `/clients/[id]/report?month=YYYY-MM` (`services/monthly-report.ts`): key takeaways from the numbers, portfolio at the start and end of the month (CAS), split by asset class, plan progress (from the views), the month's calls and executions, SIPs, trades without advice, and the advisor's own summary / outlook / actions (`client_report_notes`). Printed or saved as PDF from the browser. |

## 4. Counting rules (per advice item, `v_advice_items`)

```
executed_amount   = Σ executions.executed_amount  where status ∈ {EXECUTED, PARTIAL}
counted_advised   = advised_amount (or executed if larger)   when ISSUED / PARTIALLY_EXECUTED
                  = executed_amount                          when EXECUTED / CANCELLED / EXPIRED / REVISED
pending_amount    = counted_advised − executed_amount        (0 when not open)
```

Per plan item (`v_plan_item_progress`), over linked advice items:

```
advised        = Σ counted_advised
executed       = Σ executed_amount
pending        = Σ pending_amount           (= advised − executed)
yet_to_advise  = max(target − advised, 0)
over_advised   = max(advised − target, 0)   (flagged in the UI, never a negative remainder)
```

Client and plan totals (`v_plan_transition`, `v_client_summary`) are sums over plan items of the **ACTIVE** plan, by side (SELL = SELL + SWITCH, BUY = BUY). Off-plan calls are tracked and shown separately (`off_plan_pending`).

## 5. Status machines

- **Plan:** `DRAFT → ACTIVE → COMPLETED | REPLACED | CANCELLED`, `DRAFT → CANCELLED`, and `DRAFT → MERGED` (an additional-investment plan added to the ACTIVE plan as a tranche). At most one ACTIVE plan per client. Closing an ACTIVE plan requires a reason.
- **Advice item:** `ISSUED ⇄ PARTIALLY_EXECUTED ⇄ EXECUTED`, derived from executions. `ISSUED / PARTIALLY_EXECUTED → CANCELLED | EXPIRED | REVISED` require a reason and are terminal.
- **Execution:** `PENDING → EXECUTED`. `→ REJECTED | CANCELLED` (voiding) requires a reason. Amounts are immutable, and CAS verification can be attached once.
- **Snapshot:** `PENDING_REVIEW → CONFIRMED | REJECTED`. The first confirmed snapshot is the baseline. Holdings are frozen once reviewed.
- **CAS document:** `UPLOADED → PROCESSING → PARSED | NEEDS_REVIEW | FAILED`.
- **Reconciliation match:** `SUGGESTED → CONFIRMED | PARTIAL | REJECTED`, and `SUGGESTED | UNEXPLAINED → UNEXPLAINED (unadvised)`, which is then acknowledged via `reviewed_at`. The run is `OPEN` until nothing needs a decision.
- **SIP item:** `PLANNED → ADVISED → COMPLETED`, or `→ CANCELLED` (with a reason).

## 6. Tables (summary)

| Table | Purpose / key columns |
|---|---|
| `profiles` | Staff (1:1 `auth.users`): `role` ADMIN/ADVISOR/OPERATIONS, `is_active` |
| `clients` | `client_code` MN-xxxxx (sequence), name, contact, PAN, risk profile, goal, status, `next_review_date`, soft delete |
| `client_advisor_assignments` | PRIMARY / SECONDARY / OPERATIONS assignments, never deleted (`is_active`, `unassigned_at`) |
| `security_master` | ISIN (unique), AMFI code, name, AMC, category, plan type, aliases |
| `mf_schemes` | Every AMFI scheme by ISIN with its latest NAV (daily feed); reference data, no audit |
| `nav_feed_runs` | One row per NAV feed delivery: NAV date, schemes, holdings priced / unpriced |
| `documents` | Every stored file: type, path, SHA-256 (unique per client+type), parse status |
| `cas_documents` | CAS metadata: statement dates, valuation date, source, `password_protected`, parse status / warnings |
| `portfolio_snapshots` | One per CAS (never overwritten): totals, review status, `is_baseline` |
| `portfolio_holdings` | Folio-level lines: security, units, cost, value, NAV |
| `portfolio_transactions` | CAS transactions, de-duplicated across statements |
| `advisory_plans` | End-state plan: status, targets, frozen approved targets, source document, extraction payload |
| `advisory_plan_items` | SELL / BUY / RETAIN / SWITCH lines: target amount/units, current amount, weight, reason, priority, `needs_review` |
| `sip_plan_items` | START / STOP / CHANGE: old/new amount, frequency, debit day, status |
| `advice_batches` | One communication: `communicated_at` (immutable), channel, advisor, `batch_code` AB-xxxxxx |
| `advice_items` | One call: action, basis, advised amount/units, reference price, validity, status, `revises_advice_item_id` |
| `executions` | Fills against a call: date/time, amount, units, price, verification type, status, proof document, CAS verification |
| `reconciliation_runs` | Previous vs current snapshot, values, summary, status |
| `reconciliation_matches` | Detected change × candidate call: units, expected, allocated, confidence, classification, decision |
| `client_notes` | Notes, call logs, follow-ups (`follow_up_date`) |
| `client_fresh_money` | Fresh money the client brought in (amount, date, the additional-investment plan); counted in money left |
| `audit_logs` | Append-only: actor, actor label, client, entity, action, changed fields, old/new JSON, reason |

## 7. Future: client portal

The data model already separates staff (`profiles`) from clients. A client portal would add a `client_users` mapping (`auth.users.id → clients.id`), a `CLIENT` branch in `app.can_access_client`, and *read-only* policies on views. None of this is built in V1.
