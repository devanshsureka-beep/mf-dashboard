-- =============================================================================
-- v_client_bank, tightened: a trade counts as "in bank" when a CAS verified it,
-- or when it is dated strictly before the latest confirmed CAS. A trade on the
-- CAS date itself may not be in that CAS yet (its units would still be in the
-- fund value), so it waits for verification or the next CAS. Same columns as 0020.
-- =============================================================================

create or replace view public.v_client_bank
with (security_invoker = true) as
select
  x.client_id,
  greatest(0, x.fresh_money + x.sold - x.bought)::numeric(18,2) as in_bank,
  x.sold::numeric(18,2) as sold_in_cas,
  x.bought::numeric(18,2) as bought_in_cas,
  x.fresh_money::numeric(18,2) as fresh_money
from (
  select
    c.id as client_id,
    coalesce((select sum(f.amount) from public.client_fresh_money f where f.client_id = c.id), 0) as fresh_money,
    coalesce(t.sold, 0) as sold,
    coalesce(t.bought, 0) as bought
  from public.clients c
  left join lateral (
    select
      sum(e.executed_amount) filter (where ai.action = 'SELL') as sold,
      sum(e.executed_amount) filter (where ai.action = 'BUY') as bought
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
