-- =============================================================================
-- 0022 Migrations done as redeem + buy, and calls outside the plan.
--
-- Many "Migrate to Direct" lines are carried out by redeeming the Regular plan
-- and buying (not a SWITCH call). Such a SELL call may now link to the MIGRATE
-- line, so a CAS redemption confirmed as advised counts against the migration
-- instead of floating outside the plan.
--
-- v_client_rebalance_extra: per client, the migration progress (from calls
-- linked to MIGRATE lines; buys of the Direct plan count as its second leg)
-- and the calls linked to no plan line (sell and buy),
-- so the Rebalancing card can show everything that was advised. MIGRATE lines
-- stay out of the lump-sum sell/buy targets, as in 0014.
-- =============================================================================

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
      -- A migration is a switch, or a redemption of the Regular plan (the redeem leg).
      or (new.action in ('SWITCH', 'SELL') and v_plan_item.action = 'MIGRATE')
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

create or replace function app.guard_advice_item()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_plan_item record;
begin
  if app.admin_correction() then
    perform app.assert_unchanged(to_jsonb(old), to_jsonb(new),
      array['id', 'advice_batch_id', 'client_id', 'revises_advice_item_id', 'created_at', 'created_by'],
      'advice_items');
    if new.advised_amount < 0 or (new.quantity_basis = 'UNITS' and coalesce(new.advised_units, 0) <= 0) then
      raise exception 'A corrected call needs a positive amount (and units on a UNITS basis)' using errcode = '23514';
    end if;
    -- A corrected plan link follows the same rules as a new call.
    if new.plan_item_id is distinct from old.plan_item_id and new.plan_item_id is not null then
      select pi.client_id, pi.action, pi.status, p.status as plan_status into v_plan_item
      from public.advisory_plan_items pi join public.advisory_plans p on p.id = pi.plan_id
      where pi.id = new.plan_item_id;
      if v_plan_item.client_id is distinct from new.client_id then
        raise exception 'Plan item belongs to a different client';
      end if;
      if v_plan_item.plan_status <> 'ACTIVE' or v_plan_item.status = 'CANCELLED' then
        raise exception 'A call can only be linked to an open item of the ACTIVE plan';
      end if;
      if not (
        (new.action = 'BUY' and v_plan_item.action = 'BUY')
        or (new.action in ('SELL', 'SWITCH') and v_plan_item.action in ('SELL', 'SWITCH'))
        -- A migration is a switch, or a redemption of the Regular plan (the redeem leg).
        or (new.action in ('SWITCH', 'SELL') and v_plan_item.action = 'MIGRATE')
      ) then
        raise exception 'Advice action % does not match plan item action %', new.action, v_plan_item.action;
      end if;
    end if;
  else
    perform app.assert_unchanged(to_jsonb(old), to_jsonb(new),
      array['id', 'advice_batch_id', 'client_id', 'plan_item_id', 'security_id', 'scheme_name',
            'folio_number', 'action', 'quantity_basis', 'advised_amount', 'advised_units',
            'reference_price', 'valid_until', 'revises_advice_item_id', 'created_at', 'created_by'],
      'advice_items');
  end if;

  if new.status is distinct from old.status then
    -- Terminal states never change.
    if old.status in ('CANCELLED', 'EXPIRED', 'REVISED') then
      raise exception 'Advice item is % and cannot change status', old.status using errcode = '42501';
    end if;
    -- Manual closures require a reason and are only possible while not fully executed.
    if new.status in ('CANCELLED', 'EXPIRED', 'REVISED') then
      if old.status = 'EXECUTED' then
        raise exception 'A fully executed advice item cannot be %', new.status using errcode = '42501';
      end if;
      if coalesce(nullif(trim(new.status_reason), ''), app.audit_reason()) is null then
        raise exception 'A reason is required to mark advice %', new.status using errcode = '23514';
      end if;
    end if;
    new.status_changed_at := now();
  end if;
  return new;
end;
$$;

create or replace view public.v_client_rebalance_extra
with (security_invoker = true) as
with mig_lines as (
  select pi.client_id, pi.id, pi.target_amount
  from public.advisory_plan_items pi
  join public.advisory_plans p on p.id = pi.plan_id and p.status = 'ACTIVE'
  where pi.action = 'MIGRATE' and pi.status <> 'CANCELLED'
), mig_calls as (
  select v.plan_item_id,
         sum(v.effective_advised_amount) as advised, sum(v.executed_amount) as executed, sum(v.pending_amount) as pending
  from public.v_advice_items v
  where v.plan_item_id in (select id from mig_lines)
  group by v.plan_item_id
), mig as (
  select l.client_id,
         sum(l.target_amount) as target,
         sum(coalesce(c.advised, 0)) as advised,
         sum(coalesce(c.executed, 0)) as executed,
         sum(coalesce(c.pending, 0)) as pending,
         sum(greatest(l.target_amount - coalesce(c.advised, 0), 0)) as left_to_advise
  from mig_lines l left join mig_calls c on c.plan_item_id = l.id
  group by l.client_id
), mig_direct as (
  -- The Direct plans being migrated to: buying one is the second leg of the migration.
  select distinct pi.client_id, pi.switch_to_security_id as security_id
  from public.advisory_plan_items pi
  join public.advisory_plans p on p.id = pi.plan_id and p.status = 'ACTIVE'
  where pi.action = 'MIGRATE' and pi.status <> 'CANCELLED' and pi.switch_to_security_id is not null
), loose as (
  select v.*, (v.action = 'BUY' and d.security_id is not null) as is_mig_buy
  from public.v_advice_items v
  left join mig_direct d on d.client_id = v.client_id and d.security_id = v.security_id
  where v.plan_item_id is null
), off as (
  select client_id,
         sum(effective_advised_amount) filter (where action <> 'BUY') as sell_advised,
         sum(executed_amount) filter (where action <> 'BUY') as sell_executed,
         sum(pending_amount) filter (where action <> 'BUY') as sell_pending,
         sum(effective_advised_amount) filter (where action = 'BUY' and not is_mig_buy) as buy_advised,
         sum(executed_amount) filter (where action = 'BUY' and not is_mig_buy) as buy_executed,
         sum(pending_amount) filter (where action = 'BUY' and not is_mig_buy) as buy_pending,
         sum(effective_advised_amount) filter (where is_mig_buy) as mig_buy_advised,
         sum(executed_amount) filter (where is_mig_buy) as mig_buy_executed,
         sum(pending_amount) filter (where is_mig_buy) as mig_buy_pending
  from loose
  group by client_id
)
select
  c.id as client_id,
  coalesce(mig.target, 0)::numeric(18,2) as migrate_target,
  coalesce(mig.advised, 0)::numeric(18,2) as migrate_advised,
  coalesce(mig.executed, 0)::numeric(18,2) as migrate_executed,
  coalesce(mig.pending, 0)::numeric(18,2) as migrate_pending,
  coalesce(mig.left_to_advise, 0)::numeric(18,2) as migrate_left,
  coalesce(off.mig_buy_advised, 0)::numeric(18,2) as migrate_buy_advised,
  coalesce(off.mig_buy_executed, 0)::numeric(18,2) as migrate_buy_executed,
  coalesce(off.mig_buy_pending, 0)::numeric(18,2) as migrate_buy_pending,
  coalesce(off.sell_advised, 0)::numeric(18,2) as off_plan_sell_advised,
  coalesce(off.sell_executed, 0)::numeric(18,2) as off_plan_sell_executed,
  coalesce(off.sell_pending, 0)::numeric(18,2) as off_plan_sell_pending,
  coalesce(off.buy_advised, 0)::numeric(18,2) as off_plan_buy_advised,
  coalesce(off.buy_executed, 0)::numeric(18,2) as off_plan_buy_executed,
  coalesce(off.buy_pending, 0)::numeric(18,2) as off_plan_buy_pending
from public.clients c
left join mig on mig.client_id = c.id
left join off on off.client_id = c.id
where c.deleted_at is null;

grant select on public.v_client_rebalance_extra to authenticated;
