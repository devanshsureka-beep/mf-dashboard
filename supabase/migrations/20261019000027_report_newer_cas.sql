-- =============================================================================
-- 0027 Report + a newer CAS.
--
-- Onboarding from the report and a CAS taken after it: each difference becomes
-- a question on the plan (advisory_plan_items.report_question), with what the
-- CAS shows since the report kept in report_diff (prefills the answer: Buy /
-- Sell / Keep, and the part already done, recorded as a call + execution).
--
-- v_client_bank gets cash_at_onboarding (trailing column): trades dated on or
-- before the onboarding (baseline) CAS were the client's money at onboarding,
-- so "since onboarding" starts from them (their cash is also in in_bank).
-- =============================================================================

alter table public.advisory_plan_items add column report_diff jsonb;
comment on column public.advisory_plan_items.report_diff is 'Report vs a newer CAS: kind, report amount, CAS value, sold / bought since the report, suggested answer.';

create or replace view public.v_client_bank
with (security_invoker = true) as
select
  x.client_id,
  greatest(0, x.fresh_money + x.sold - x.bought)::numeric(18,2) as in_bank,
  x.sold::numeric(18,2) as sold_in_cas,
  x.bought::numeric(18,2) as bought_in_cas,
  x.fresh_money::numeric(18,2) as fresh_money,
  -- Trades done before onboarding (recorded from a CAS newer than the report): their cash was the
  -- client's at onboarding, so "since onboarding" starts from it too.
  x.cash_at_onboarding::numeric(18,2) as cash_at_onboarding
from (
  select
    c.id as client_id,
    coalesce((select sum(f.amount) from public.client_fresh_money f where f.client_id = c.id), 0) as fresh_money,
    coalesce(t.sold, 0) as sold,
    coalesce(t.bought, 0) as bought,
    coalesce(t.cash_at_onboarding, 0) as cash_at_onboarding
  from public.clients c
  left join lateral (
    select
      sum(e.executed_amount) filter (where ai.action = 'SELL') as sold,
      sum(e.executed_amount) filter (where ai.action = 'BUY') as bought,
      sum(case when ai.action = 'BUY' then -e.executed_amount else e.executed_amount end)
        filter (where e.execution_date <= (select s.snapshot_date from public.portfolio_snapshots s where s.client_id = c.id and s.is_baseline)) as cash_at_onboarding
    from public.executions e
    join public.advice_items ai on ai.id = e.advice_item_id
    where e.client_id = c.id
      and e.status in ('EXECUTED', 'PARTIAL')
      and (e.cas_verified_at is not null
           or e.execution_date < (
             select max(s.snapshot_date) from public.portfolio_snapshots s
             where s.client_id = c.id and s.review_status = 'CONFIRMED'))
  ) t on true
  where c.deleted_at is null
) x;

grant select on public.v_client_bank to authenticated;
