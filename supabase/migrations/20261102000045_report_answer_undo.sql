-- 1. Undo of a report-check answer restores the line exactly as it was (action, amount, reason,
--    review flag), not a bare Keep: the answer keeps a copy of the line from before it.
-- 2. Transactions count once a CAS that read them is CONFIRMED (not while it waits for a check).

alter table public.advisory_plan_items add column if not exists report_before jsonb;

create or replace view public.v_cas_transactions
with (security_invoker = true) as
select t.*
from public.portfolio_transactions t
where exists (
  select 1 from public.portfolio_snapshot_transactions l
  join public.portfolio_snapshots s on s.id = l.snapshot_id
  where l.transaction_id = t.id and s.review_status = 'CONFIRMED');
