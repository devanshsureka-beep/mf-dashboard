-- =============================================================================
-- 0014 Migrate to Direct: a Regular holding moved to the Direct plan of the same
-- fund. A plan line of its own (MIGRATE), tracked as a checklist and executed
-- through SWITCH calls. It is NOT part of the lump-sum sell/buy targets (the
-- money stays in the same fund), so the five numbers and money left are unchanged.
-- =============================================================================

alter table public.advisory_plan_items drop constraint advisory_plan_items_action_check;
alter table public.advisory_plan_items add constraint advisory_plan_items_action_check check (action in (
  'SELL', 'BUY', 'RETAIN', 'SWITCH', 'STOP_SIP', 'START_SIP', 'MIGRATE'));

-- SWITCH calls may be linked to MIGRATE lines.
create or replace function app.prepare_advice_item()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_batch record;
  v_plan_item record;
begin
  select client_id, status into v_batch from public.advice_batches where id = new.advice_batch_id;
  if v_batch.client_id is null then
    raise exception 'Advice batch % not found', new.advice_batch_id;
  end if;
  if v_batch.status <> 'ACTIVE' then
    raise exception 'Cannot add advice to a cancelled batch';
  end if;
  new.client_id := v_batch.client_id;

  if new.plan_item_id is not null then
    select pi.client_id, pi.action, pi.status, p.status as plan_status
      into v_plan_item
    from public.advisory_plan_items pi
    join public.advisory_plans p on p.id = pi.plan_id
    where pi.id = new.plan_item_id;

    if v_plan_item.client_id is distinct from new.client_id then
      raise exception 'Plan item belongs to a different client';
    end if;
    if v_plan_item.plan_status <> 'ACTIVE' then
      raise exception 'Advice can only be linked to items of an ACTIVE plan (plan is %)', v_plan_item.plan_status;
    end if;
    if v_plan_item.status = 'CANCELLED' then
      raise exception 'Plan item is cancelled';
    end if;
    if not (
      (new.action = 'BUY' and v_plan_item.action = 'BUY')
      or (new.action in ('SELL', 'SWITCH') and v_plan_item.action in ('SELL', 'SWITCH'))
      or (new.action = 'SWITCH' and v_plan_item.action = 'MIGRATE')
    ) then
      raise exception 'Advice action % does not match plan item action %', new.action, v_plan_item.action;
    end if;
  end if;

  if tg_op = 'INSERT' then
    new.status := 'ISSUED';
    new.status_changed_at := now();
  end if;
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Migration checklist: one row per MIGRATE line.
--   DONE         its switch call(s) were executed and none is open
--   DONE_IN_CAS  the latest CAS holds no Regular units and some Direct units
--   CALL_ISSUED  a switch call is open
--   TO_DO        nothing yet
-- -----------------------------------------------------------------------------
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
), latest as (
  select h.client_id, h.security_id, sum(h.units) as units
  from public.portfolio_holdings h
  join public.v_latest_snapshot l on l.snapshot_id = h.snapshot_id
  group by h.client_id, h.security_id
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
left join latest r on r.client_id = pi.client_id and r.security_id = pi.security_id
left join latest d on d.client_id = pi.client_id and d.security_id = pi.switch_to_security_id
left join public.security_master sm on sm.id = pi.switch_to_security_id
where pi.action = 'MIGRATE';

grant select on public.v_migration_progress to authenticated;
