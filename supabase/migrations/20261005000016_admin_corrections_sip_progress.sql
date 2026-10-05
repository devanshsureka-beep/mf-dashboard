-- =============================================================================
-- 1. Admin corrections. An ADMIN, with a reason (app.audit_reason), may correct
--    a call (amount, units, basis, NAV, fund, plan line, date, channel) and an
--    execution (amount, units, date, NAV). Every change is in the audit log with
--    old and new values. Identity columns, CAS verification links and terminal
--    statuses stay protected for everyone. Changing a call's or an execution's
--    quantities re-derives the call's status.
-- 2. SIP progress. Per SIP plan line: the monthly amount and what has actually
--    been invested through SIP instalments seen in CAS since the line was
--    advised (or the plan approved). Per client: the SIP transition (monthly
--    target / advised / started / yet to advise, invested so far) and the total
--    invested under the plan (lump-sum buys executed + SIP invested).
-- =============================================================================

create or replace function app.admin_correction()
returns boolean
language sql
stable
set search_path = ''
as $$
  select app.is_admin() and app.audit_reason() is not null
$$;

-- -----------------------------------------------------------------------------
-- Advice batches (when and how the client was told)
-- -----------------------------------------------------------------------------
create or replace function app.guard_advice_batch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if app.admin_correction() then
    perform app.assert_unchanged(to_jsonb(old), to_jsonb(new),
      array['id', 'batch_code', 'client_id', 'created_at', 'created_by'], 'advice_batches');
    if new.communicated_at > now() then
      raise exception 'A call cannot be dated in the future' using errcode = '23514';
    end if;
  else
    perform app.assert_unchanged(to_jsonb(old), to_jsonb(new),
      array['id', 'batch_code', 'client_id', 'advisor_id', 'plan_id', 'communicated_at',
            'communication_channel', 'created_at', 'created_by'],
      'advice_batches');
  end if;
  if old.status = 'CANCELLED' and new.status <> 'CANCELLED' then
    raise exception 'A cancelled advice batch cannot be re-activated' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Advice items
-- -----------------------------------------------------------------------------
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
        or (new.action = 'SWITCH' and v_plan_item.action = 'MIGRATE')
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

create or replace function app.after_advice_correction()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform app.refresh_advice_item_status(new.id);
  return null;
end;
$$;

drop trigger if exists advice_items_refresh_after_correction on public.advice_items;
create trigger advice_items_refresh_after_correction
  after update of advised_amount, advised_units, quantity_basis on public.advice_items
  for each row execute function app.after_advice_correction();

-- -----------------------------------------------------------------------------
-- Executions
-- -----------------------------------------------------------------------------
create or replace function app.guard_execution()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if app.admin_correction() then
    perform app.assert_unchanged(to_jsonb(old), to_jsonb(new),
      array['id', 'client_id', 'advice_item_id', 'verification_type', 'created_at', 'created_by'],
      'executions');
    if new.execution_date > app.today_ist() then
      raise exception 'Execution date cannot be in the future' using errcode = '23514';
    end if;
    if new.executed_amount < 0 or coalesce(new.executed_units, 0) < 0 then
      raise exception 'Executed amount and units cannot be negative' using errcode = '23514';
    end if;
  else
    perform app.assert_unchanged(to_jsonb(old), to_jsonb(new),
      array['id', 'client_id', 'advice_item_id', 'security_id', 'execution_date', 'execution_time',
            'executed_amount', 'executed_units', 'execution_price', 'verification_type',
            'proof_document_id', 'created_at', 'created_by'],
      'executions');
  end if;

  -- CAS verification can be attached once, never changed or removed.
  if old.cas_verified_at is not null and (
       new.cas_verified_at is distinct from old.cas_verified_at
       or new.cas_verification_match_id is distinct from old.cas_verification_match_id) then
    raise exception 'CAS verification of an execution cannot be changed' using errcode = '42501';
  end if;

  if new.status is distinct from old.status then
    if old.status in ('REJECTED', 'CANCELLED') then
      raise exception 'Execution is % and cannot change status', old.status using errcode = '42501';
    end if;
    if new.status in ('REJECTED', 'CANCELLED')
       and coalesce(nullif(trim(new.status_reason), ''), app.audit_reason()) is null then
      raise exception 'A reason is required to mark an execution %', new.status using errcode = '23514';
    end if;
    new.status_changed_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists executions_refresh_advice_values on public.executions;
create trigger executions_refresh_advice_values
  after update of executed_amount, executed_units on public.executions
  for each row execute function app.after_execution_change();

-- -----------------------------------------------------------------------------
-- SIP progress
-- -----------------------------------------------------------------------------
create or replace view public.v_sip_item_progress
with (security_invoker = true) as
select
  s.id as sip_item_id,
  s.plan_id,
  s.client_id,
  p.status as plan_status,
  s.security_id,
  s.scheme_name,
  s.action,
  s.status as item_status,
  s.frequency,
  s.old_amount,
  s.new_amount,
  (case when s.action = 'STOP' then 0 else coalesce(s.new_amount, 0) end)::numeric(18,2) as monthly_amount,
  coalesce((s.advised_at at time zone 'Asia/Kolkata')::date, (p.approved_at at time zone 'Asia/Kolkata')::date) as since_date,
  coalesce(inv.amount, 0)::numeric(18,2) as invested_amount,
  coalesce(inv.instalments, 0) as instalments,
  inv.last_date as last_instalment_date
from public.sip_plan_items s
join public.advisory_plans p on p.id = s.plan_id
left join lateral (
  select sum(abs(t.amount)) as amount, count(*) as instalments, max(t.transaction_date) as last_date
  from public.portfolio_transactions t
  where s.action in ('START', 'CHANGE') and s.security_id is not null
    and t.client_id = s.client_id and t.security_id = s.security_id
    and t.transaction_type = 'SIP' and coalesce(t.amount, 0) <> 0
    and t.transaction_date >= coalesce((s.advised_at at time zone 'Asia/Kolkata')::date,
                                       (p.approved_at at time zone 'Asia/Kolkata')::date, s.created_at::date)
) inv on true;

comment on view public.v_sip_item_progress is
  'SIP plan lines: monthly amount and what SIP instalments seen in CAS have invested since the line was advised (or the plan approved). No projection.';

create or replace view public.v_client_sip
with (security_invoker = true) as
select
  c.id as client_id,
  coalesce(sum(v.monthly_amount) filter (where v.item_status <> 'CANCELLED'), 0)::numeric(18,2) as sip_monthly_target,
  coalesce(sum(v.monthly_amount) filter (where v.item_status in ('ADVISED', 'COMPLETED')), 0)::numeric(18,2) as sip_monthly_advised,
  coalesce(sum(v.monthly_amount) filter (where v.item_status = 'COMPLETED'), 0)::numeric(18,2) as sip_monthly_started,
  coalesce(sum(v.monthly_amount) filter (where v.item_status = 'PLANNED'), 0)::numeric(18,2) as sip_monthly_yet_to_advise,
  coalesce(sum(v.invested_amount) filter (where v.item_status <> 'CANCELLED'), 0)::numeric(18,2) as sip_invested,
  count(v.sip_item_id) filter (where v.action = 'STOP' and v.item_status <> 'CANCELLED') as sips_to_stop,
  count(v.sip_item_id) filter (where v.action = 'STOP' and v.item_status = 'COMPLETED') as sips_stopped,
  coalesce(max(t.buy_executed), 0)::numeric(18,2) as lumpsum_buy_executed,
  (coalesce(max(t.buy_executed), 0)
   + coalesce(sum(v.invested_amount) filter (where v.item_status <> 'CANCELLED'), 0))::numeric(18,2) as total_invested_under_plan
from public.clients c
left join public.v_sip_item_progress v on v.client_id = c.id and v.plan_status = 'ACTIVE'
left join public.v_plan_transition t on t.client_id = c.id and t.status = 'ACTIVE'
group by c.id;

comment on view public.v_client_sip is
  'Per client, ACTIVE plan: SIP transition in ₹/month, SIP invested so far, and total invested under the plan = lump-sum buys executed + SIP invested.';

grant select on public.v_sip_item_progress, public.v_client_sip to authenticated;
