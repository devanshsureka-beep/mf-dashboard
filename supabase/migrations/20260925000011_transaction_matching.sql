-- =============================================================================
-- MN Advisory Dashboard — 0011 Transaction-level reconciliation
--
-- A detailed CAS lists each redemption / purchase with date, amount, units and
-- NAV. Reconciliation (engine v2) matches those transactions to calls, so a
-- match now carries the exact CAS transaction it came from. Clear matches are
-- auto-confirmed (business decision 2026-09-25); `auto_confirmed` records that
-- no person made the decision.
-- =============================================================================

alter table public.reconciliation_matches
  add column cas_transaction_id  uuid references public.portfolio_transactions (id),
  add column transaction_date    date,
  add column transaction_amount  numeric(18,2),
  add column transaction_units   numeric(20,4),
  add column transaction_nav     numeric(18,4),
  add column auto_confirmed      boolean not null default false;

create index reconciliation_matches_txn_idx on public.reconciliation_matches (cas_transaction_id);

-- A CAS transaction is attributed to a given call at most once.
create unique index reconciliation_matches_txn_advice_unique
  on public.reconciliation_matches (cas_transaction_id, coalesce(advice_item_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where cas_transaction_id is not null and status <> 'REJECTED';

-- The transaction evidence of a match is as immutable as the detected change.
create or replace function app.guard_reconciliation_match()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform app.assert_unchanged(to_jsonb(old), to_jsonb(new),
    array['id', 'run_id', 'client_id', 'advice_item_id', 'security_id', 'previous_units',
          'current_units', 'detected_change', 'expected_change', 'confidence', 'created_at',
          'cas_transaction_id', 'transaction_date', 'transaction_amount', 'transaction_units',
          'transaction_nav', 'auto_confirmed'],
    'reconciliation_matches');
  if old.status in ('CONFIRMED', 'PARTIAL', 'REJECTED') and new.status is distinct from old.status then
    raise exception 'Match already resolved as %', old.status using errcode = '42501';
  end if;
  if old.execution_id is not null and new.execution_id is distinct from old.execution_id then
    raise exception 'Execution link of a match cannot change' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Advised -> executed timing per call (IST calendar days).
-- lag_days: call date -> first execution; completion_lag_days: call date ->
-- last execution, only once the call is fully EXECUTED.
-- -----------------------------------------------------------------------------
create or replace view public.v_advice_execution_timing
with (security_invoker = true) as
select
  ai.id as advice_item_id,
  ai.client_id,
  b.communicated_at,
  (b.communicated_at at time zone 'Asia/Kolkata')::date as advised_date,
  min(e.execution_date) as first_execution_date,
  max(e.execution_date) as last_execution_date,
  (min(e.execution_date) - (b.communicated_at at time zone 'Asia/Kolkata')::date) as lag_days,
  (case when ai.status = 'EXECUTED'
        then max(e.execution_date) - (b.communicated_at at time zone 'Asia/Kolkata')::date end) as completion_lag_days,
  bool_or(e.verification_type = 'CAS_VERIFIED' or e.cas_verified_at is not null) as cas_verified
from public.advice_items ai
join public.advice_batches b on b.id = ai.advice_batch_id
join public.executions e on e.advice_item_id = ai.id and e.status in ('EXECUTED', 'PARTIAL')
group by ai.id, ai.client_id, ai.status, b.communicated_at;

grant select on public.v_advice_execution_timing to authenticated;
