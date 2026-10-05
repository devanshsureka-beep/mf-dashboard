-- =============================================================================
-- Migrate to Direct: a Regular fund held in several folios has one MIGRATE line
-- per folio. Each line now shows (and its switch call advises) only the units
-- in its own folio, not the fund's units across every folio.
-- Same columns as 0014; only the regular_units_now source changes.
-- =============================================================================

create or replace view public.v_migration_progress
with (security_invoker = true) as
with adv as (
  select plan_item_id,
         sum(effective_advised_amount) as advised_amount,
         sum(executed_amount) as executed_amount,
         count(*) filter (where is_open) as open_calls,
         max(communicated_at) as last_advised_at
  from public.v_advice_items
  where plan_item_id is not null
  group by plan_item_id
), held as (
  select h.client_id, h.security_id, h.folio_number, h.units
  from public.portfolio_holdings h
  join public.v_latest_snapshot l on l.snapshot_id = h.snapshot_id
), latest as (
  select client_id, security_id, sum(units) as units
  from held
  group by client_id, security_id
)
select
  pi.id as plan_item_id,
  pi.plan_id,
  pi.client_id,
  p.status as plan_status,
  pi.security_id,
  pi.scheme_name,
  pi.folio_number,
  pi.switch_to_security_id,
  sm.scheme_name as switch_to_scheme_name,
  pi.target_amount::numeric(18,2) as current_value,
  pi.reason,
  pi.status as item_status,
  pi.tranche_plan_id,
  coalesce(adv.advised_amount, 0)::numeric(18,2) as advised_amount,
  coalesce(adv.executed_amount, 0)::numeric(18,2) as executed_amount,
  coalesce(adv.open_calls, 0) as open_calls,
  adv.last_advised_at,
  coalesce(r.units, 0)::numeric(20,4) as regular_units_now,
  coalesce(d.units, 0)::numeric(20,4) as direct_units_now,
  (case
     when pi.status = 'CANCELLED' then 'CANCELLED'
     when pi.status = 'COMPLETED' then 'DONE'
     when coalesce(adv.executed_amount, 0) > 0 and coalesce(adv.open_calls, 0) = 0 then 'DONE'
     when coalesce(r.units, 0) = 0 and coalesce(d.units, 0) > 0 then 'DONE_IN_CAS'
     when coalesce(adv.open_calls, 0) > 0 then 'CALL_ISSUED'
     else 'TO_DO'
   end) as migration_status
from public.advisory_plan_items pi
join public.advisory_plans p on p.id = pi.plan_id
left join adv on adv.plan_item_id = pi.id
-- Units in this line's folio when it names one, else across the fund's folios.
left join lateral (
  select sum(h.units) as units from held h
  where h.client_id = pi.client_id and h.security_id = pi.security_id
    and (pi.folio_number is null or h.folio_number = pi.folio_number)
) r on true
left join latest d on d.client_id = pi.client_id and d.security_id = pi.switch_to_security_id
left join public.security_master sm on sm.id = pi.switch_to_security_id
where pi.action = 'MIGRATE';

grant select on public.v_migration_progress to authenticated;
