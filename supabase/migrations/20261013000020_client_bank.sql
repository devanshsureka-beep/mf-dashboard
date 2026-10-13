-- =============================================================================
-- Money "in bank" per client: fresh money + sells − buys, counting only trades
-- the latest confirmed CAS already shows (execution date on or before it).
-- The fund value comes from that same CAS, so the two always add up: a sell the
-- CAS has not shown yet is still counted in the fund, not in the bank.
-- Switches move money fund to fund and are left out, as in v_client_cash.
-- Written as per-client subqueries (index lookups) so joining it to a list of
-- clients stays cheap under RLS.
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
      and e.execution_date <= (
        select max(s.snapshot_date) from public.portfolio_snapshots s
        where s.client_id = c.id and s.review_status = 'CONFIRMED')
  ) t on true
  where c.deleted_at is null
) x;

grant select on public.v_client_bank to authenticated;
