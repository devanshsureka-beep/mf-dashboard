-- =============================================================================
-- 0023 Plan lines are Buy, Sell or Keep only.
--
-- Migrate to Direct and Switch lines confused tracking: their calls did not
-- show in the sell/buy numbers. Each one becomes plain lines:
--   * MIGRATE (Regular -> Direct of the same fund): SELL the Regular plan and
--     BUY the Direct plan, same amount (it is done as redeem + buy).
--   * SWITCH (fund A -> fund B): SELL A, and BUY B when B is known (a switch
--     whose target the report lists as a buy is already a buy line).
-- Lines of open plans (DRAFT, ACTIVE) are converted here; closed plans keep
-- their history. New plan lines may only be BUY, SELL, RETAIN (Keep) or the
-- SIP actions (STOP_SIP / START_SIP); the old values stay valid for history.
--
-- v_client_rebalance_extra (0022) now only lists calls outside the plan.
-- =============================================================================

select set_config('app.audit_reason', 'Plan lines simplified to Buy / Sell / Keep (Migrate to Direct and Switch lines converted)', true);

-- The Buy leg of each migration / switch with a known target fund.
insert into public.advisory_plan_items
  (plan_id, client_id, security_id, scheme_name, folio_number, action, target_amount, target_units, current_amount,
   target_weight, reason, priority, notes, status, needs_review, created_by, tranche_plan_id)
select pi.plan_id, pi.client_id, pi.switch_to_security_id, sm.scheme_name, null, 'BUY', pi.target_amount, null, null,
       null,
       case when pi.action = 'MIGRATE' then 'Migrate to Direct: buy the Direct plan with the Regular redemption'
            else 'Switch: buy with the money from ' || pi.scheme_name end,
       coalesce(pi.priority, 0) + 1, null, pi.status, false, pi.created_by, pi.tranche_plan_id
from public.advisory_plan_items pi
join public.advisory_plans p on p.id = pi.plan_id and p.status in ('DRAFT', 'ACTIVE')
join public.security_master sm on sm.id = pi.switch_to_security_id
where pi.action in ('MIGRATE', 'SWITCH') and pi.status <> 'CANCELLED' and pi.target_amount > 0;

-- The Sell leg: the line itself (calls linked to it stay linked).
update public.advisory_plan_items pi set
  action = 'SELL',
  reason = case when pi.action = 'MIGRATE'
                then 'Migrate to Direct: redeem the Regular plan' || coalesce('; ' || nullif(regexp_replace(coalesce(pi.reason, ''), '^(Kept for now: )?(MIGRATE TO DIRECT;?\s*)?', '', 'i'), ''), '')
                else coalesce(pi.reason, 'Switch out') end
from public.advisory_plans p
where p.id = pi.plan_id and p.status in ('DRAFT', 'ACTIVE')
  and pi.action in ('MIGRATE', 'SWITCH') and pi.status <> 'CANCELLED';

-- New lines: Buy, Sell, Keep (and SIP actions) only.
create or replace function app.plan_item_buy_sell_keep()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.action in ('MIGRATE', 'SWITCH') and (tg_op = 'INSERT' or new.action is distinct from old.action) then
    raise exception 'Plan lines are Buy, Sell or Keep: enter a % as a Sell of the old fund and a Buy of the new one', lower(new.action)
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger advisory_plan_items_buy_sell_keep
  before insert or update of action on public.advisory_plan_items
  for each row execute function app.plan_item_buy_sell_keep();

-- Calls outside the plan only (migration columns dropped with the MIGRATE lines).
drop view if exists public.v_client_rebalance_extra;
create view public.v_client_rebalance_extra
with (security_invoker = true) as
with off as (
  select v.client_id,
         sum(v.effective_advised_amount) filter (where v.action <> 'BUY') as sell_advised,
         sum(v.executed_amount) filter (where v.action <> 'BUY') as sell_executed,
         sum(v.pending_amount) filter (where v.action <> 'BUY') as sell_pending,
         sum(v.effective_advised_amount) filter (where v.action = 'BUY') as buy_advised,
         sum(v.executed_amount) filter (where v.action = 'BUY') as buy_executed,
         sum(v.pending_amount) filter (where v.action = 'BUY') as buy_pending
  from public.v_advice_items v
  where v.plan_item_id is null
  group by v.client_id
)
select
  c.id as client_id,
  coalesce(off.sell_advised, 0)::numeric(18,2) as off_plan_sell_advised,
  coalesce(off.sell_executed, 0)::numeric(18,2) as off_plan_sell_executed,
  coalesce(off.sell_pending, 0)::numeric(18,2) as off_plan_sell_pending,
  coalesce(off.buy_advised, 0)::numeric(18,2) as off_plan_buy_advised,
  coalesce(off.buy_executed, 0)::numeric(18,2) as off_plan_buy_executed,
  coalesce(off.buy_pending, 0)::numeric(18,2) as off_plan_buy_pending
from public.clients c
left join off on off.client_id = c.id
where c.deleted_at is null;

grant select on public.v_client_rebalance_extra to authenticated;
