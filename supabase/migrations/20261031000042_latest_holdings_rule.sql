-- Edit holdings, fixes:
-- 1. The latest holdings: the newest CAS (by statement date), unless a hand correction was saved
--    AFTER that CAS was confirmed. A CAS confirmed after a correction replaces it, whatever its
--    statement date (CAS dates lag: a CAS of 15-Oct confirmed on 18-Oct replaces a correction of 17-Oct).
-- 2. Money in bank counts trades up to the date of those same holdings (not the newest date of
--    any snapshot), so a CAS that replaced a later-dated correction does not count its trades twice.

create or replace view public.v_latest_snapshot
with (security_invoker = true) as
with cas as (
  select distinct on (s.client_id) s.*, coalesce(s.reviewed_at, s.created_at) as current_from
  from public.portfolio_snapshots s
  where s.review_status = 'CONFIRMED' and not s.is_correction
  order by s.client_id, s.snapshot_date desc, s.created_at desc
), fix as (
  select distinct on (s.client_id) s.*, s.created_at as current_from
  from public.portfolio_snapshots s
  where s.review_status = 'CONFIRMED' and s.is_correction
  order by s.client_id, s.created_at desc
)
select distinct on (x.client_id)
  x.client_id,
  x.id as snapshot_id,
  x.snapshot_date,
  x.total_current_value,
  x.total_invested_value,
  x.total_gain_loss,
  x.cas_document_id
from (select * from cas union all select * from fix) x
order by x.client_id, x.current_from desc;

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
             select l.snapshot_date from public.v_latest_snapshot l where l.client_id = c.id))
  ) t on true
  where c.deleted_at is null
) x;


grant select on public.v_client_bank to authenticated;
