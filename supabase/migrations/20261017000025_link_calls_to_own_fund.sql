-- =============================================================================
-- 0025 Every call on a Buy / Sell line.
--
-- A call recorded for a fund the plan did not cover (or recorded before its
-- line existed) is put on the Buy / Sell line of its own fund by the app
-- (services/advice.ts ensurePlanLine). Until now only an admin correction could
-- change a call's plan link. Now anyone allowed to update the call may set a
-- MISSING link, with an audit reason, to an open line of the ACTIVE plan for
-- the same client, the same fund and the same side. Changing an existing link
-- stays an admin correction.
-- =============================================================================

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
  elsif old.plan_item_id is null and new.plan_item_id is not null then
    -- A call outside the plan may be put on the Buy / Sell line of its own fund
    -- (with a reason); nothing else about the call changes.
    perform app.assert_unchanged(to_jsonb(old), to_jsonb(new),
      array['id', 'advice_batch_id', 'client_id', 'security_id', 'scheme_name',
            'folio_number', 'action', 'quantity_basis', 'advised_amount', 'advised_units',
            'reference_price', 'valid_until', 'revises_advice_item_id', 'created_at', 'created_by'],
      'advice_items');
    if app.audit_reason() is null then
      raise exception 'A reason is required to put a call on a plan line' using errcode = '23514';
    end if;
    select pi.client_id, pi.action, pi.status, pi.security_id, p.status as plan_status into v_plan_item
    from public.advisory_plan_items pi join public.advisory_plans p on p.id = pi.plan_id
    where pi.id = new.plan_item_id;
    if v_plan_item.client_id is distinct from new.client_id or v_plan_item.security_id is distinct from new.security_id then
      raise exception 'A call can only be put on the plan line of its own fund';
    end if;
    if v_plan_item.plan_status <> 'ACTIVE' or v_plan_item.status = 'CANCELLED' then
      raise exception 'A call can only be linked to an open item of the ACTIVE plan';
    end if;
    if not ((new.action = 'BUY' and v_plan_item.action = 'BUY')
            or (new.action in ('SELL', 'SWITCH') and v_plan_item.action in ('SELL', 'SWITCH', 'MIGRATE'))) then
      raise exception 'Advice action % does not match plan item action %', new.action, v_plan_item.action;
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
