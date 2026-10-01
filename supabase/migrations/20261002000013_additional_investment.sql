-- =============================================================================
-- 0013 Additional investment: a later report for fresh money is added to the
-- client's ACTIVE plan as a new tranche instead of replacing it, and the fresh
-- money is recorded so "money left" = fresh money + sells - buys.
-- =============================================================================

alter table public.advisory_plans
  add column plan_kind text not null default 'FULL' check (plan_kind in ('FULL', 'ADDITIONAL')),
  add column fresh_money numeric(18,2) check (fresh_money is null or fresh_money >= 0),
  add column merged_into_plan_id uuid references public.advisory_plans (id);

alter table public.advisory_plans drop constraint advisory_plans_status_check;
alter table public.advisory_plans add constraint advisory_plans_status_check check (status in (
  'DRAFT', 'ACTIVE', 'COMPLETED', 'REPLACED', 'CANCELLED', 'MERGED'));

-- Lines added to an ACTIVE plan by a merged additional-investment plan.
alter table public.advisory_plan_items add column tranche_plan_id uuid references public.advisory_plans (id);
alter table public.sip_plan_items add column tranche_plan_id uuid references public.advisory_plans (id);
create index advisory_plan_items_tranche_idx on public.advisory_plan_items (tranche_plan_id) where tranche_plan_id is not null;

-- -----------------------------------------------------------------------------
-- Fresh money the client brought in (not proceeds of a sell).
-- -----------------------------------------------------------------------------
create table public.client_fresh_money (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients (id),
  amount      numeric(18,2) not null check (amount > 0),
  received_on date not null default app.today_ist(),
  plan_id     uuid references public.advisory_plans (id),
  note        text,
  created_at  timestamptz not null default now(),
  created_by  uuid references public.profiles (id)
);
create index client_fresh_money_client_idx on public.client_fresh_money (client_id, received_on);

grant select, insert on public.client_fresh_money to authenticated;
grant all on public.client_fresh_money to service_role;
alter table public.client_fresh_money enable row level security;
create policy client_fresh_money_select on public.client_fresh_money
  for select to authenticated using (app.can_access_client(client_id));
create policy client_fresh_money_insert on public.client_fresh_money
  for insert to authenticated
  with check (app.can_advise_client(client_id) and created_by = (select auth.uid()));

create trigger client_fresh_money_audit after insert or update or delete on public.client_fresh_money
  for each row execute function app.audit_row_change();
create trigger client_fresh_money_no_delete before delete on public.client_fresh_money
  for each row execute function app.forbid_delete();

-- -----------------------------------------------------------------------------
-- Plan guard: DRAFT -> MERGED (into the client's ACTIVE plan).
-- -----------------------------------------------------------------------------
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
      (old.status = 'DRAFT' and new.status in ('ACTIVE', 'CANCELLED', 'MERGED'))
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

    if new.status = 'MERGED' then
      -- An additional-investment plan is merged into the client's ACTIVE plan as a new tranche.
      if new.merged_into_plan_id is null or not exists (
        select 1 from public.advisory_plans
        where id = new.merged_into_plan_id and client_id = new.client_id and status = 'ACTIVE'
      ) then
        raise exception 'A merged plan must point to the client''s ACTIVE plan' using errcode = '23514';
      end if;
      new.closed_at := now();
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

-- -----------------------------------------------------------------------------
-- Money left = fresh money + sell proceeds - buys (executed calls).
-- Same columns as 0012 (money_left now counts fresh money), plus fresh_money.
-- -----------------------------------------------------------------------------
create or replace view public.v_client_cash
with (security_invoker = true) as
with ex as (
  select
    e.client_id,
    coalesce(sum(e.executed_amount) filter (where ai.action = 'SELL'), 0) as sell_proceeds,
    coalesce(sum(e.executed_amount) filter (where ai.action = 'BUY'), 0) as buy_spent,
    max(e.execution_date) as last_execution_date
  from public.executions e
  join public.advice_items ai on ai.id = e.advice_item_id
  where e.status in ('EXECUTED', 'PARTIAL')
  group by e.client_id
), fm as (
  select client_id, sum(amount) as fresh_money from public.client_fresh_money group by client_id
)
select
  coalesce(ex.client_id, fm.client_id) as client_id,
  coalesce(ex.sell_proceeds, 0)::numeric(18,2) as sell_proceeds,
  coalesce(ex.buy_spent, 0)::numeric(18,2) as buy_spent,
  (coalesce(fm.fresh_money, 0) + coalesce(ex.sell_proceeds, 0) - coalesce(ex.buy_spent, 0))::numeric(18,2) as money_left,
  ex.last_execution_date,
  coalesce(fm.fresh_money, 0)::numeric(18,2) as fresh_money
from ex
full join fm on fm.client_id = ex.client_id;
