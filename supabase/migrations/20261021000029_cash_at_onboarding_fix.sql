-- =============================================================================
-- v_client_bank.cash_at_onboarding, aligned with in_bank:
--  * same date rule: trades dated BEFORE the onboarding CAS (in_bank counts a
--    trade only once a later CAS could show it, i.e. dated before it);
--  * never below what in_bank allows: in_bank is clamped at 0, so a buy made
--    before onboarding with money we never saw must not lower the start value
--    (it showed a gain that did not exist).
-- Same columns as before (Supabase cannot drop the view).
-- =============================================================================
create or replace view public.v_client_bank
with (security_invoker = true) as
select
  x.client_id,
  greatest(0, x.fresh_money + x.sold - x.bought)::numeric(18,2) as in_bank,
  x.sold::numeric(18,2) as sold_in_cas,
  x.bought::numeric(18,2) as bought_in_cas,
  x.fresh_money::numeric(18,2) as fresh_money,
  greatest(x.cash_at_onboarding, -x.fresh_money)::numeric(18,2) as cash_at_onboarding
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
        filter (where e.execution_date < (select s.snapshot_date from public.portfolio_snapshots s where s.client_id = c.id and s.is_baseline)) as cash_at_onboarding
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
