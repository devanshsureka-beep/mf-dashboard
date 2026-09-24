-- =============================================================================
-- MN Advisory Dashboard — 0007 Business-rule triggers
--
-- These triggers make the non-negotiable rules hold regardless of which code
-- path writes to the database (UI, integration endpoint, SQL console):
--   * audit trail on every important table
--   * immutable advice / execution / snapshot history
--   * advice status derived from executions (partial execution support)
--   * ACTIVE plan changes require a written reason
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Audit context helpers.
-- Server code sets these per transaction with set_config(..., true):
--   app.audit_reason  -> free-text reason for the change
--   app.actor_label   -> label for non-user writers ('integration:n8n', 'seed')
-- -----------------------------------------------------------------------------
create or replace function app.audit_reason()
returns text
language sql
stable
set search_path = ''
as $$
  select nullif(trim(current_setting('app.audit_reason', true)), '')
$$;

create or replace function app.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_row jsonb := coalesce(v_new, v_old);
  v_changed text[];
  v_client uuid;
begin
  if tg_op = 'UPDATE' then
    select array_agg(k order by k) into v_changed
    from jsonb_object_keys(v_new) k
    where k not in ('updated_at')
      and (v_new -> k) is distinct from (v_old -> k);
    if v_changed is null then
      return null; -- nothing meaningful changed
    end if;
  end if;

  v_client := case
    when tg_table_name = 'clients' then (v_row ->> 'id')::uuid
    else (v_row ->> 'client_id')::uuid
  end;

  insert into public.audit_logs
    (actor_id, actor_label, client_id, entity_type, entity_id, action, changed_fields, old_value, new_value, reason)
  values (
    auth.uid(),
    nullif(current_setting('app.actor_label', true), ''),
    v_client,
    tg_table_name,
    (v_row ->> 'id')::uuid,
    tg_op,
    v_changed,
    v_old,
    v_new,
    app.audit_reason()
  );
  return null;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'clients', 'client_advisor_assignments', 'profiles', 'security_master', 'documents',
    'cas_documents', 'portfolio_snapshots',
    'advisory_plans', 'advisory_plan_items', 'sip_plan_items',
    'advice_batches', 'advice_items', 'executions',
    'reconciliation_runs', 'reconciliation_matches', 'client_notes'
  ] loop
    execute format(
      'create trigger %I after insert or update or delete on public.%I
         for each row execute function app.audit_row_change()',
      t || '_audit', t);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- No hard deletes of financial history.
-- (Draft plan items and pending-review holdings are the only exceptions.)
-- -----------------------------------------------------------------------------
create or replace function app.forbid_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% rows cannot be deleted; use a status change or soft delete instead', tg_table_name
    using errcode = '42501';
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'clients', 'client_advisor_assignments', 'documents', 'cas_documents', 'portfolio_snapshots',
    'portfolio_transactions', 'advisory_plans', 'advice_batches', 'advice_items', 'executions',
    'reconciliation_runs', 'reconciliation_matches', 'client_notes', 'security_master'
  ] loop
    execute format(
      'create trigger %I before delete on public.%I
         for each row execute function app.forbid_delete()',
      t || '_no_delete', t);
  end loop;
end $$;

-- Helper: raise if any listed column changed.
create or replace function app.assert_unchanged(p_old jsonb, p_new jsonb, p_cols text[], p_context text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  c text;
begin
  foreach c in array p_cols loop
    if (p_old -> c) is distinct from (p_new -> c) then
      raise exception '%: field "%" is immutable', p_context, c using errcode = '42501';
    end if;
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Advice batches: timestamps, client and advisor are immutable.
-- -----------------------------------------------------------------------------
create or replace function app.guard_advice_batch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform app.assert_unchanged(to_jsonb(old), to_jsonb(new),
    array['id', 'batch_code', 'client_id', 'advisor_id', 'plan_id', 'communicated_at',
          'communication_channel', 'created_at', 'created_by'],
    'advice_batches');
  if old.status = 'CANCELLED' and new.status <> 'CANCELLED' then
    raise exception 'A cancelled advice batch cannot be re-activated' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger advice_batches_guard
  before update on public.advice_batches
  for each row execute function app.guard_advice_batch();

-- -----------------------------------------------------------------------------
-- Advice items
-- -----------------------------------------------------------------------------
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

create trigger advice_items_prepare
  before insert on public.advice_items
  for each row execute function app.prepare_advice_item();

create or replace function app.guard_advice_item()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform app.assert_unchanged(to_jsonb(old), to_jsonb(new),
    array['id', 'advice_batch_id', 'client_id', 'plan_item_id', 'security_id', 'scheme_name',
          'folio_number', 'action', 'quantity_basis', 'advised_amount', 'advised_units',
          'reference_price', 'valid_until', 'revises_advice_item_id', 'created_at', 'created_by'],
    'advice_items');

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

create trigger advice_items_guard
  before update on public.advice_items
  for each row execute function app.guard_advice_item();

-- Recompute ISSUED / PARTIALLY_EXECUTED / EXECUTED from counted executions.
-- Tolerance for AMOUNT basis: 1% (NAV moves between advice and execution).
create or replace function app.refresh_advice_item_status(p_advice_item_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.advice_items%rowtype;
  v_amount numeric;
  v_units numeric;
  v_new_status text;
begin
  select * into v_item from public.advice_items where id = p_advice_item_id for update;
  if not found or v_item.status in ('CANCELLED', 'EXPIRED', 'REVISED') then
    return;
  end if;

  select coalesce(sum(e.executed_amount), 0), coalesce(sum(e.executed_units), 0)
    into v_amount, v_units
  from public.executions e
  where e.advice_item_id = p_advice_item_id and e.status in ('EXECUTED', 'PARTIAL');

  if v_item.quantity_basis = 'UNITS' then
    v_new_status := case
      when v_units >= v_item.advised_units - 0.001 then 'EXECUTED'
      when v_units > 0 or v_amount > 0 then 'PARTIALLY_EXECUTED'
      else 'ISSUED' end;
  else
    v_new_status := case
      when v_amount >= v_item.advised_amount * 0.99 then 'EXECUTED'
      when v_amount > 0 or v_units > 0 then 'PARTIALLY_EXECUTED'
      else 'ISSUED' end;
  end if;

  if v_new_status is distinct from v_item.status then
    update public.advice_items
       set status = v_new_status,
           status_reason = 'Derived from executions'
     where id = p_advice_item_id;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Executions
-- -----------------------------------------------------------------------------
create or replace function app.prepare_execution()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_advice record;
begin
  select client_id, security_id, status into v_advice
  from public.advice_items where id = new.advice_item_id;
  if v_advice.client_id is null then
    raise exception 'Advice item % not found', new.advice_item_id;
  end if;
  new.client_id := v_advice.client_id;
  new.security_id := coalesce(new.security_id, v_advice.security_id);
  if new.execution_date > app.today_ist() then
    raise exception 'Execution date cannot be in the future';
  end if;
  if new.verification_type = 'CAS_VERIFIED' and new.cas_verification_match_id is null then
    raise exception 'CAS_VERIFIED executions must come from a confirmed reconciliation match';
  end if;
  new.status_changed_at := now();
  return new;
end;
$$;

create trigger executions_prepare
  before insert on public.executions
  for each row execute function app.prepare_execution();

create or replace function app.guard_execution()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform app.assert_unchanged(to_jsonb(old), to_jsonb(new),
    array['id', 'client_id', 'advice_item_id', 'security_id', 'execution_date', 'execution_time',
          'executed_amount', 'executed_units', 'execution_price', 'verification_type',
          'proof_document_id', 'created_at', 'created_by'],
    'executions');

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

create trigger executions_guard
  before update on public.executions
  for each row execute function app.guard_execution();

create or replace function app.after_execution_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform app.refresh_advice_item_status(new.advice_item_id);
  return null;
end;
$$;

create trigger executions_refresh_advice
  after insert or update of status on public.executions
  for each row execute function app.after_execution_change();

-- -----------------------------------------------------------------------------
-- Advisory plans
-- -----------------------------------------------------------------------------
create or replace function app.recompute_plan_targets(p_plan_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.advisory_plans p
     set target_exit_value = coalesce(t.exit_value, 0),
         target_buy_value  = coalesce(t.buy_value, 0),
         target_sip_value  = coalesce(s.sip_value, 0)
    from (
      select
        sum(target_amount) filter (where action in ('SELL', 'SWITCH') and status <> 'CANCELLED') as exit_value,
        sum(target_amount) filter (where action = 'BUY' and status <> 'CANCELLED') as buy_value
      from public.advisory_plan_items where plan_id = p_plan_id
    ) t,
    (
      select sum(new_amount) filter (where action in ('START', 'CHANGE') and status <> 'CANCELLED') as sip_value
      from public.sip_plan_items where plan_id = p_plan_id
    ) s
   where p.id = p_plan_id
     and (p.target_exit_value, p.target_buy_value, p.target_sip_value)
         is distinct from (coalesce(t.exit_value, 0), coalesce(t.buy_value, 0), coalesce(s.sip_value, 0));
end;
$$;

create or replace function app.guard_advisory_plan()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'DRAFT' then
      raise exception 'Plans must be created as DRAFT and approved explicitly';
    end if;
    return new;
  end if;

  perform app.assert_unchanged(to_jsonb(old), to_jsonb(new),
    array['id', 'client_id', 'created_at', 'created_by', 'source_document_id', 'extraction_source'],
    'advisory_plans');

  if old.status <> 'DRAFT' then
    perform app.assert_unchanged(to_jsonb(old), to_jsonb(new),
      array['plan_name', 'plan_date', 'baseline_snapshot_id', 'starting_portfolio_value',
            'approved_target_exit_value', 'approved_target_buy_value', 'approved_target_sip_value',
            'approved_at', 'approved_by', 'locked_at', 'extraction_payload'],
      'advisory_plans (approved)');
  end if;

  if new.status is distinct from old.status then
    if not (
      (old.status = 'DRAFT' and new.status in ('ACTIVE', 'CANCELLED'))
      or (old.status = 'ACTIVE' and new.status in ('COMPLETED', 'REPLACED', 'CANCELLED'))
    ) then
      raise exception 'Invalid plan status transition % -> %', old.status, new.status using errcode = '42501';
    end if;

    if new.status = 'ACTIVE' then
      if exists (
        select 1 from public.advisory_plan_items
        where plan_id = new.id and status <> 'CANCELLED'
          and action in ('SELL', 'BUY', 'SWITCH') and security_id is null
      ) then
        raise exception 'Every SELL/BUY/SWITCH item needs a resolved security before approval';
      end if;
      if exists (
        select 1 from public.advisory_plan_items where plan_id = new.id and needs_review and status <> 'CANCELLED'
      ) or exists (
        select 1 from public.sip_plan_items where plan_id = new.id and needs_review and status <> 'CANCELLED'
      ) then
        raise exception 'Some plan items are flagged "needs review"; resolve them before approval';
      end if;
      new.approved_at := coalesce(new.approved_at, now());
      new.approved_by := coalesce(new.approved_by, auth.uid());
      new.locked_at := now();
      new.approved_target_exit_value := new.target_exit_value;
      new.approved_target_buy_value := new.target_buy_value;
      new.approved_target_sip_value := new.target_sip_value;
    end if;

    if new.status in ('COMPLETED', 'REPLACED', 'CANCELLED') then
      new.closed_at := now();
      if old.status = 'ACTIVE' and app.audit_reason() is null and nullif(trim(new.notes), '') is null then
        raise exception 'A reason is required to close an active plan' using errcode = '23514';
      end if;
    end if;
  elsif old.status <> 'DRAFT' then
    -- Target totals of an approved plan move only through item amendments
    -- (which require a reason, see guard_plan_item).
    if (new.target_exit_value, new.target_buy_value, new.target_sip_value)
       is distinct from (old.target_exit_value, old.target_buy_value, old.target_sip_value)
       and app.audit_reason() is null then
      raise exception 'Changing targets of an approved plan requires a reason' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create trigger advisory_plans_guard
  before insert or update on public.advisory_plans
  for each row execute function app.guard_advisory_plan();

-- Plan items: client consistency, DRAFT-only deletes, reasons for amendments.
create or replace function app.guard_plan_item()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_plan record;
  v_row record;
begin
  v_row := case when tg_op = 'DELETE' then old else new end;
  select client_id, status into v_plan from public.advisory_plans where id = v_row.plan_id;

  if tg_op = 'DELETE' then
    if v_plan.status <> 'DRAFT' then
      raise exception 'Items of an approved plan cannot be deleted; cancel them instead' using errcode = '42501';
    end if;
    return old;
  end if;

  new.client_id := v_plan.client_id;

  if v_plan.status in ('COMPLETED', 'REPLACED', 'CANCELLED') then
    raise exception 'Plan is % and can no longer be edited', v_plan.status using errcode = '42501';
  end if;

  if v_plan.status = 'ACTIVE' then
    if tg_op = 'INSERT' and app.audit_reason() is null then
      raise exception 'Adding an item to an ACTIVE plan requires a reason' using errcode = '23514';
    end if;
    if tg_op = 'UPDATE' then
      perform app.assert_unchanged(to_jsonb(old), to_jsonb(new),
        array['id', 'plan_id', 'client_id', 'created_at', 'created_by'], 'advisory_plan_items');
      if (new.security_id, new.action, new.target_amount, new.target_units, new.status)
         is distinct from (old.security_id, old.action, old.target_amount, old.target_units, old.status)
         and app.audit_reason() is null then
        raise exception 'Amending an item of an ACTIVE plan requires a reason' using errcode = '23514';
      end if;
      if old.status = 'CANCELLED' and new.status <> 'CANCELLED' then
        raise exception 'A cancelled plan item cannot be re-opened' using errcode = '42501';
      end if;
    end if;
  end if;
  return new;
end;
$$;

create trigger advisory_plan_items_guard
  before insert or update or delete on public.advisory_plan_items
  for each row execute function app.guard_plan_item();

create or replace function app.after_plan_item_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform app.recompute_plan_targets(coalesce(new.plan_id, old.plan_id));
  return null;
end;
$$;

create trigger advisory_plan_items_recompute
  after insert or update or delete on public.advisory_plan_items
  for each row execute function app.after_plan_item_change();

-- SIP items follow the same plan-state rules.
create or replace function app.guard_sip_item()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_plan record;
  v_row record;
begin
  v_row := case when tg_op = 'DELETE' then old else new end;
  select client_id, status into v_plan from public.advisory_plans where id = v_row.plan_id;

  if tg_op = 'DELETE' then
    if v_plan.status <> 'DRAFT' then
      raise exception 'SIP items of an approved plan cannot be deleted; cancel them instead' using errcode = '42501';
    end if;
    return old;
  end if;

  new.client_id := v_plan.client_id;
  if v_plan.status in ('COMPLETED', 'REPLACED', 'CANCELLED') and tg_op = 'INSERT' then
    raise exception 'Plan is % and can no longer be edited', v_plan.status using errcode = '42501';
  end if;

  if v_plan.status <> 'DRAFT' and tg_op = 'UPDATE' then
    perform app.assert_unchanged(to_jsonb(old), to_jsonb(new),
      array['id', 'plan_id', 'client_id', 'created_at', 'created_by'], 'sip_plan_items');
    if (new.security_id, new.action, new.old_amount, new.new_amount, new.frequency)
       is distinct from (old.security_id, old.action, old.old_amount, old.new_amount, old.frequency)
       and app.audit_reason() is null then
      raise exception 'Amending a SIP item of an approved plan requires a reason' using errcode = '23514';
    end if;
  end if;
  if v_plan.status = 'ACTIVE' and tg_op = 'INSERT' and app.audit_reason() is null then
    raise exception 'Adding a SIP item to an ACTIVE plan requires a reason' using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if old.status in ('COMPLETED', 'CANCELLED') then
      raise exception 'SIP item is % and cannot change status', old.status using errcode = '42501';
    end if;
    if v_plan.status = 'DRAFT' and new.status in ('ADVISED', 'COMPLETED') then
      raise exception 'SIP actions can only progress once the plan is ACTIVE' using errcode = '42501';
    end if;
    if new.status = 'ADVISED' then new.advised_at := coalesce(new.advised_at, now()); end if;
    if new.status = 'COMPLETED' then
      new.advised_at := coalesce(new.advised_at, now());
      new.completed_at := coalesce(new.completed_at, now());
    end if;
  end if;
  return new;
end;
$$;

create trigger sip_plan_items_guard
  before insert or update or delete on public.sip_plan_items
  for each row execute function app.guard_sip_item();

create trigger sip_plan_items_recompute
  after insert or update or delete on public.sip_plan_items
  for each row execute function app.after_plan_item_change();

-- -----------------------------------------------------------------------------
-- Snapshots and holdings
-- -----------------------------------------------------------------------------
create or replace function app.guard_snapshot()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform app.assert_unchanged(to_jsonb(old), to_jsonb(new),
    array['id', 'client_id', 'cas_document_id', 'source', 'extraction_method', 'created_at', 'created_by'],
    'portfolio_snapshots');

  if old.review_status <> 'PENDING_REVIEW' then
    perform app.assert_unchanged(to_jsonb(old), to_jsonb(new),
      array['snapshot_date', 'total_invested_value', 'total_current_value', 'review_status',
            'reviewed_at', 'reviewed_by', 'holdings_count'],
      'portfolio_snapshots (reviewed)');
    if old.is_baseline and not new.is_baseline then
      raise exception 'Baseline flag cannot be removed' using errcode = '42501';
    end if;
  end if;

  if new.review_status is distinct from old.review_status then
    new.reviewed_at := coalesce(new.reviewed_at, now());
    new.reviewed_by := coalesce(new.reviewed_by, auth.uid());
  end if;
  return new;
end;
$$;

create trigger portfolio_snapshots_guard
  before update on public.portfolio_snapshots
  for each row execute function app.guard_snapshot();

create or replace function app.guard_holding()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_row record;
  v_snapshot record;
begin
  v_row := case when tg_op = 'DELETE' then old else new end;
  select client_id, review_status into v_snapshot
  from public.portfolio_snapshots where id = v_row.snapshot_id;

  if v_snapshot.review_status <> 'PENDING_REVIEW' then
    raise exception 'Holdings of a reviewed snapshot are immutable' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  new.client_id := v_snapshot.client_id;
  return new;
end;
$$;

create trigger portfolio_holdings_guard
  before insert or update or delete on public.portfolio_holdings
  for each row execute function app.guard_holding();

create or replace function app.guard_transaction()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'Portfolio transactions are immutable' using errcode = '42501';
  end if;
  select client_id into new.client_id from public.portfolio_snapshots where id = new.source_snapshot_id;
  return new;
end;
$$;

create trigger portfolio_transactions_guard
  before insert or update on public.portfolio_transactions
  for each row execute function app.guard_transaction();

-- -----------------------------------------------------------------------------
-- CAS documents: file identity is immutable.
-- -----------------------------------------------------------------------------
create or replace function app.guard_cas_document()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform app.assert_unchanged(to_jsonb(old), to_jsonb(new),
    array['id', 'client_id', 'document_id', 'file_path', 'file_sha256', 'uploaded_at',
          'created_at', 'created_by'],
    'cas_documents');
  return new;
end;
$$;

create trigger cas_documents_guard
  before update on public.cas_documents
  for each row execute function app.guard_cas_document();

create or replace function app.guard_document()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform app.assert_unchanged(to_jsonb(old), to_jsonb(new),
    array['id', 'client_id', 'document_type', 'file_path', 'sha256', 'size_bytes', 'created_at', 'created_by'],
    'documents');
  return new;
end;
$$;

create trigger documents_guard
  before update on public.documents
  for each row execute function app.guard_document();

-- -----------------------------------------------------------------------------
-- Reconciliation matches: a resolved match stays resolved.
-- -----------------------------------------------------------------------------
create or replace function app.guard_reconciliation_match()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform app.assert_unchanged(to_jsonb(old), to_jsonb(new),
    array['id', 'run_id', 'client_id', 'advice_item_id', 'security_id', 'previous_units',
          'current_units', 'detected_change', 'expected_change', 'confidence', 'created_at'],
    'reconciliation_matches');
  if old.status in ('CONFIRMED', 'PARTIAL', 'REJECTED') and new.status is distinct from old.status then
    raise exception 'Match already resolved as %', old.status using errcode = '42501';
  end if;
  if old.execution_id is not null and new.execution_id is distinct from old.execution_id then
    raise exception 'Execution link of a match cannot change' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger reconciliation_matches_guard
  before update on public.reconciliation_matches
  for each row execute function app.guard_reconciliation_match();

-- Client notes: only the text/follow-up fields of your own note may change.
create or replace function app.guard_client_note()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform app.assert_unchanged(to_jsonb(old), to_jsonb(new),
    array['id', 'client_id', 'created_at', 'created_by', 'advice_item_id'], 'client_notes');
  return new;
end;
$$;

create trigger client_notes_guard
  before update on public.client_notes
  for each row execute function app.guard_client_note();
