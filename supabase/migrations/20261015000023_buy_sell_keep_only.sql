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
-- v_client_rebalance_extra (0022) stays: with no MIGRATE lines left its
-- migrate_* columns read 0; the app uses only its off_plan_* columns.
-- =============================================================================

do $$ begin perform set_config('app.audit_reason', 'Plan lines simplified to Buy / Sell / Keep (Migrate to Direct and Switch lines converted)', true); end $$;

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
