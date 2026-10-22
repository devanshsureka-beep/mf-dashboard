-- =============================================================================
-- 0048 Approved trades the latest CAS does not show stay "approved"
--
-- An approval dated before the latest CAS used to count in the CAS figures, as if that CAS
-- showed it. When the CAS was confirmed after the approval and still does not show it
-- (the desk chose "Keep waiting" in the CAS inbox), that CAS still holds the units: counting
-- the sale in the bank as well would count the money twice. It now stays an approval
-- (in bank now, out of funds now) until a CAS verifies it.
-- =============================================================================

create or replace view public.v_client_bank
with (security_invoker = true) as
select
  x.client_id,
  greatest(0, x.fresh_money + x.sold + x.approved_sold - x.bought - x.approved_bought)::numeric(18,2) as in_bank,
  x.sold::numeric(18,2) as sold_in_cas,
  x.bought::numeric(18,2) as bought_in_cas,
  x.fresh_money::numeric(18,2) as fresh_money,
  greatest(x.cash_at_onboarding, -x.fresh_money)::numeric(18,2) as cash_at_onboarding,
  greatest(0, x.fresh_money + x.sold - x.bought)::numeric(18,2) as in_bank_cas,
  x.approved_sold::numeric(18,2) as approved_sold,
  x.approved_bought::numeric(18,2) as approved_bought,
  x.approved_count::int as approved_count
from (
  select
    c.id as client_id,
    coalesce((select sum(f.amount) from public.client_fresh_money f where f.client_id = c.id), 0) as fresh_money,
    coalesce(t.sold, 0) as sold,
    coalesce(t.bought, 0) as bought,
    coalesce(t.cash_at_onboarding, 0) as cash_at_onboarding,
    coalesce(t.approved_sold, 0) as approved_sold,
    coalesce(t.approved_bought, 0) as approved_bought,
    coalesce(t.approved_count, 0) as approved_count
  from public.clients c
  left join lateral (
    select
      sum(e.executed_amount) filter (where e.in_cas and ai.action = 'SELL') as sold,
      sum(e.executed_amount) filter (where e.in_cas and ai.action = 'BUY') as bought,
      sum(case when ai.action = 'BUY' then -e.executed_amount else e.executed_amount end)
        filter (where e.in_cas and e.execution_date < (select s.snapshot_date from public.portfolio_snapshots s where s.client_id = c.id and s.is_baseline)) as cash_at_onboarding,
      sum(e.executed_amount) filter (where e.approved and ai.action = 'SELL') as approved_sold,
      sum(e.executed_amount) filter (where e.approved and ai.action = 'BUY') as approved_bought,
      count(*) filter (where e.approved) as approved_count
    from (
      select e.*, e.in_cas_ as in_cas,
             -- Approved: confirmed by the client or advisor (the waiting page, or by hand), not in the CAS
             -- figures yet. "Done before onboarding" (PROOF_VERIFIED, proof = that CAS) is not an approval.
             (not e.in_cas_ and e.verification_type in ('CLIENT_CONFIRMED', 'ADVISOR_CONFIRMED')) as approved
      from (
        select e.*,
               -- In the CAS figures: verified by a CAS, or dated before the latest CAS (which then includes it)
               -- unless it is an approval that CAS was confirmed after and still does not show (kept waiting):
               -- that CAS still holds the units, so the trade stays "approved" until a CAS shows it.
               coalesce(e.cas_verified_at is not null
                or (e.execution_date < ls.snapshot_date
                    and not (e.verification_type in ('CLIENT_CONFIRMED', 'ADVISOR_CONFIRMED') and e.created_at < ls.current_from)), false) as in_cas_
        from public.executions e
        left join lateral (
          select l.snapshot_date, coalesce(ps.reviewed_at, ps.created_at) as current_from
          from public.v_latest_snapshot l join public.portfolio_snapshots ps on ps.id = l.snapshot_id
          where l.client_id = c.id) ls on true
        where e.client_id = c.id and e.status in ('EXECUTED', 'PARTIAL')
      ) e
    ) e
    join public.advice_items ai on ai.id = e.advice_item_id
  ) t on true
  where c.deleted_at is null
) x;

grant select on public.v_client_bank to authenticated;
