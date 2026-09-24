-- =============================================================================
-- MN Advisory Dashboard — 0008 Metrics views (the single source of the
-- Target / Advised / Executed / Pending / Yet-to-advise numbers)
--
-- All views are SECURITY INVOKER, so Row Level Security of the underlying
-- tables applies to whoever queries them.
--
-- Counting rules (per advice item):
--   executed_amount  = sum of executions with status EXECUTED or PARTIAL
--   counted_advised  =
--       ISSUED / PARTIALLY_EXECUTED -> max(advised_amount, executed_amount)
--       EXECUTED                    -> executed_amount   (closed; any shortfall
--                                      returns to "yet to advise")
--       CANCELLED / EXPIRED / REVISED -> executed_amount (only the part that was
--                                      actually acted on stays "advised"; a
--                                      revision's replacement item carries the rest)
--   pending_amount   = counted_advised - executed_amount   (never negative)
--
-- Per plan item:
--   advised          = sum(counted_advised) of linked advice items
--   executed         = sum(executed_amount)
--   pending          = sum(pending_amount)          = advised - executed
--   yet_to_advise    = max(target - advised, 0)
--   over_advised     = max(advised - target, 0)     (flagged, never negative remainders)
-- =============================================================================

create or replace view public.v_advice_item_progress
with (security_invoker = true) as
with ex as (
  select
    e.advice_item_id,
    sum(e.executed_amount) filter (where e.status in ('EXECUTED', 'PARTIAL')) as executed_amount,
    sum(e.executed_units)  filter (where e.status in ('EXECUTED', 'PARTIAL')) as executed_units,
    sum(e.executed_amount) filter (where e.status in ('EXECUTED', 'PARTIAL') and e.cas_verified_at is null
                                     and e.verification_type <> 'CAS_VERIFIED') as unverified_amount,
    count(*) filter (where e.status in ('EXECUTED', 'PARTIAL')) as execution_count,
    max(e.execution_date) filter (where e.status in ('EXECUTED', 'PARTIAL')) as last_execution_date
  from public.executions e
  group by e.advice_item_id
),
base as (
  select
    ai.*,
    b.batch_code,
    b.advisor_id,
    b.communicated_at,
    b.communication_channel,
    b.plan_id as batch_plan_id,
    coalesce(ex.executed_amount, 0)::numeric(18,2) as executed_amount,
    coalesce(ex.executed_units, 0)::numeric(20,4) as executed_units,
    coalesce(ex.unverified_amount, 0)::numeric(18,2) as unverified_executed_amount,
    coalesce(ex.execution_count, 0) as execution_count,
    ex.last_execution_date
  from public.advice_items ai
  join public.advice_batches b on b.id = ai.advice_batch_id
  left join ex on ex.advice_item_id = ai.id
)
select
  base.*,
  (case
     when status in ('ISSUED', 'PARTIALLY_EXECUTED') then greatest(advised_amount, executed_amount)
     else executed_amount
   end)::numeric(18,2) as counted_advised_amount,
  (case
     when status in ('ISSUED', 'PARTIALLY_EXECUTED') and quantity_basis = 'UNITS'
       then greatest(advised_units - executed_units, 0)
   end)::numeric(20,4) as pending_units,
  (status in ('ISSUED', 'PARTIALLY_EXECUTED')) as is_open,
  (app.today_ist() - (communicated_at at time zone 'Asia/Kolkata')::date) as age_days
from base;

-- Clean pending: guarantee counted_advised = executed + pending even for
-- unit-basis calls whose rupee estimate differs from actual proceeds.
create or replace view public.v_advice_items
with (security_invoker = true) as
select
  p.*,
  (case
     when p.is_open then greatest(p.counted_advised_amount - p.executed_amount, 0)
     else 0
   end)::numeric(18,2) as pending_amount,
  (case
     when p.is_open then p.executed_amount + greatest(p.counted_advised_amount - p.executed_amount, 0)
     else p.counted_advised_amount
   end)::numeric(18,2) as effective_advised_amount,
  (case when p.advised_amount > 0
     then round(least(p.executed_amount / p.advised_amount, 1) * 100, 1) end) as execution_pct
from public.v_advice_item_progress p;

comment on view public.v_advice_items is
  'Advice items with execution roll-ups. effective_advised_amount = executed_amount + pending_amount always.';

-- -----------------------------------------------------------------------------
create or replace view public.v_plan_item_progress
with (security_invoker = true) as
with adv as (
  select
    plan_item_id,
    sum(effective_advised_amount) as advised_amount,
    sum(executed_amount) as executed_amount,
    sum(pending_amount) as pending_amount,
    count(*) filter (where is_open) as open_calls,
    count(*) as total_calls,
    max(communicated_at) as last_advised_at
  from public.v_advice_items
  where plan_item_id is not null
  group by plan_item_id
)
select
  pi.id as plan_item_id,
  pi.plan_id,
  pi.client_id,
  p.status as plan_status,
  pi.security_id,
  pi.scheme_name,
  pi.folio_number,
  pi.action,
  case when pi.action in ('SELL', 'SWITCH') then 'SELL'
       when pi.action = 'BUY' then 'BUY'
       else 'NONE' end as side,
  pi.status as item_status,
  pi.priority,
  pi.reason,
  pi.notes,
  pi.needs_review,
  pi.current_amount,
  pi.target_weight,
  pi.target_units,
  (case when pi.status = 'CANCELLED' or pi.action not in ('SELL', 'SWITCH', 'BUY') then 0
        else pi.target_amount end)::numeric(18,2) as target_amount,
  pi.target_amount as original_target_amount,
  coalesce(adv.advised_amount, 0)::numeric(18,2) as advised_amount,
  coalesce(adv.executed_amount, 0)::numeric(18,2) as executed_amount,
  coalesce(adv.pending_amount, 0)::numeric(18,2) as pending_amount,
  (case when pi.status = 'CANCELLED' or pi.action not in ('SELL', 'SWITCH', 'BUY') then 0
        else greatest(pi.target_amount - coalesce(adv.advised_amount, 0), 0) end)::numeric(18,2) as yet_to_advise_amount,
  (case when pi.action not in ('SELL', 'SWITCH', 'BUY') then 0
        else greatest(coalesce(adv.advised_amount, 0) - case when pi.status = 'CANCELLED' then 0 else pi.target_amount end, 0)
   end)::numeric(18,2) as over_advised_amount,
  -- Target value of the holding after the plan (for SELL: current - exit).
  (case when pi.action in ('SELL', 'SWITCH') and pi.current_amount is not null
          then greatest(pi.current_amount - pi.target_amount, 0)
        when pi.action = 'RETAIN' then pi.current_amount
        when pi.action = 'BUY' then coalesce(pi.current_amount, 0) + pi.target_amount
   end)::numeric(18,2) as target_value,
  coalesce(adv.open_calls, 0) as open_calls,
  coalesce(adv.total_calls, 0) as total_calls,
  adv.last_advised_at,
  (case when pi.target_amount > 0 and pi.action in ('SELL', 'SWITCH', 'BUY')
     then round(least(coalesce(adv.executed_amount, 0) / pi.target_amount, 1) * 100, 1) end) as completion_pct,
  (case when pi.target_amount > 0 and pi.action in ('SELL', 'SWITCH', 'BUY')
     then round(least(coalesce(adv.advised_amount, 0) / pi.target_amount, 1) * 100, 1) end) as advised_pct,
  (case
     when pi.status = 'CANCELLED' then 'CANCELLED'
     when pi.action not in ('SELL', 'SWITCH', 'BUY') then pi.action
     when pi.status = 'COMPLETED' then 'COMPLETED'
     when coalesce(adv.executed_amount, 0) >= pi.target_amount * 0.99 then 'COMPLETED'
     when coalesce(adv.pending_amount, 0) > 0 then 'AWAITING_EXECUTION'
     when coalesce(adv.executed_amount, 0) > 0 then 'IN_PROGRESS'
     else 'NOT_ADVISED'
   end) as progress_status
from public.advisory_plan_items pi
join public.advisory_plans p on p.id = pi.plan_id
left join adv on adv.plan_item_id = pi.id;

-- -----------------------------------------------------------------------------
-- Plan-level transition (both sides) for every plan.
-- -----------------------------------------------------------------------------
create or replace view public.v_plan_transition
with (security_invoker = true) as
select
  p.id as plan_id,
  p.client_id,
  p.plan_name,
  p.plan_date,
  p.status,
  p.starting_portfolio_value,
  p.approved_target_exit_value,
  p.approved_target_buy_value,
  coalesce(sum(v.target_amount) filter (where v.side = 'SELL'), 0)::numeric(18,2)        as sell_target,
  coalesce(sum(v.advised_amount) filter (where v.side = 'SELL'), 0)::numeric(18,2)       as sell_advised,
  coalesce(sum(v.executed_amount) filter (where v.side = 'SELL'), 0)::numeric(18,2)      as sell_executed,
  coalesce(sum(v.pending_amount) filter (where v.side = 'SELL'), 0)::numeric(18,2)       as sell_pending,
  coalesce(sum(v.yet_to_advise_amount) filter (where v.side = 'SELL'), 0)::numeric(18,2) as sell_yet_to_advise,
  coalesce(sum(v.over_advised_amount) filter (where v.side = 'SELL'), 0)::numeric(18,2)  as sell_over_advised,
  coalesce(sum(v.target_amount) filter (where v.side = 'BUY'), 0)::numeric(18,2)         as buy_target,
  coalesce(sum(v.advised_amount) filter (where v.side = 'BUY'), 0)::numeric(18,2)        as buy_advised,
  coalesce(sum(v.executed_amount) filter (where v.side = 'BUY'), 0)::numeric(18,2)       as buy_executed,
  coalesce(sum(v.pending_amount) filter (where v.side = 'BUY'), 0)::numeric(18,2)        as buy_pending,
  coalesce(sum(v.yet_to_advise_amount) filter (where v.side = 'BUY'), 0)::numeric(18,2)  as buy_yet_to_advise,
  coalesce(sum(v.over_advised_amount) filter (where v.side = 'BUY'), 0)::numeric(18,2)   as buy_over_advised,
  count(v.plan_item_id) filter (where v.side <> 'NONE' and v.item_status <> 'CANCELLED') as actionable_items,
  count(v.plan_item_id) filter (where v.progress_status = 'COMPLETED' and v.side <> 'NONE') as completed_items
from public.advisory_plans p
left join public.v_plan_item_progress v on v.plan_id = p.id
group by p.id;

-- -----------------------------------------------------------------------------
-- Snapshots: latest confirmed + baseline per client.
-- -----------------------------------------------------------------------------
create or replace view public.v_latest_snapshot
with (security_invoker = true) as
select distinct on (s.client_id)
  s.client_id,
  s.id as snapshot_id,
  s.snapshot_date,
  s.total_current_value,
  s.total_invested_value,
  s.total_gain_loss,
  s.cas_document_id
from public.portfolio_snapshots s
where s.review_status = 'CONFIRMED'
order by s.client_id, s.snapshot_date desc, s.created_at desc;

create or replace view public.v_snapshot_change
with (security_invoker = true) as
select
  s.id as snapshot_id,
  s.client_id,
  s.snapshot_date,
  s.total_current_value,
  prev.id as previous_snapshot_id,
  prev.snapshot_date as previous_snapshot_date,
  prev.total_current_value as previous_value,
  (s.total_current_value - prev.total_current_value)::numeric(18,2) as value_change,
  case when prev.total_current_value > 0
       then round((s.total_current_value - prev.total_current_value) / prev.total_current_value * 100, 2)
  end as value_change_pct
from public.portfolio_snapshots s
left join lateral (
  select p.* from public.portfolio_snapshots p
  where p.client_id = s.client_id and p.review_status = 'CONFIRMED'
    and (p.snapshot_date, p.created_at) < (s.snapshot_date, s.created_at)
  order by p.snapshot_date desc, p.created_at desc
  limit 1
) prev on true
where s.review_status = 'CONFIRMED';

-- -----------------------------------------------------------------------------
-- Client summary (Clients page, Client 360 header)
-- -----------------------------------------------------------------------------
create or replace view public.v_client_summary
with (security_invoker = true) as
select
  c.id as client_id,
  c.client_code,
  c.full_name,
  c.email,
  c.phone,
  c.pan,
  c.onboarding_date,
  c.risk_profile,
  c.goal,
  c.status,
  c.next_review_date,
  c.created_at,
  adv.advisor_id,
  adv.advisor_name,
  ls.snapshot_id as latest_snapshot_id,
  ls.snapshot_date as latest_cas_date,
  ls.total_current_value as current_portfolio_value,
  bs.total_current_value as initial_portfolio_value,
  bs.snapshot_date as baseline_date,
  ap.id as active_plan_id,
  ap.plan_name as active_plan_name,
  coalesce(t.sell_target, 0) as target_sell,
  coalesce(t.sell_advised, 0) as advised_sell,
  coalesce(t.sell_executed, 0) as executed_sell,
  coalesce(t.sell_pending, 0) as pending_sell,
  coalesce(t.sell_yet_to_advise, 0) as yet_to_advise_sell,
  coalesce(t.buy_target, 0) as target_buy,
  coalesce(t.buy_advised, 0) as advised_buy,
  coalesce(t.buy_executed, 0) as executed_buy,
  coalesce(t.buy_pending, 0) as pending_buy,
  coalesce(t.buy_yet_to_advise, 0) as yet_to_advise_buy,
  coalesce(open_adv.open_calls, 0) as open_calls,
  coalesce(open_adv.pending_total, 0)::numeric(18,2) as pending_total,
  coalesce(open_adv.off_plan_pending, 0)::numeric(18,2) as off_plan_pending,
  coalesce(att.unadvised_count, 0) as unadvised_count
from public.clients c
left join lateral (
  select a.advisor_id, pr.full_name as advisor_name
  from public.client_advisor_assignments a
  join public.profiles pr on pr.id = a.advisor_id
  where a.client_id = c.id and a.is_active and a.assignment_role = 'PRIMARY'
  limit 1
) adv on true
left join public.v_latest_snapshot ls on ls.client_id = c.id
left join public.portfolio_snapshots bs on bs.client_id = c.id and bs.is_baseline
left join public.advisory_plans ap on ap.client_id = c.id and ap.status = 'ACTIVE'
left join public.v_plan_transition t on t.plan_id = ap.id
left join lateral (
  select
    count(*) filter (where v.is_open) as open_calls,
    sum(v.pending_amount) as pending_total,
    sum(v.pending_amount) filter (where v.plan_item_id is null) as off_plan_pending
  from public.v_advice_items v
  where v.client_id = c.id
) open_adv on true
left join lateral (
  select count(*) as unadvised_count
  from public.reconciliation_matches m
  where m.client_id = c.id and m.status = 'UNEXPLAINED'
    and m.classification = 'UNADVISED' and m.reviewed_at is null
) att on true
where c.deleted_at is null;

-- -----------------------------------------------------------------------------
-- Pending executions (Page 6)
-- -----------------------------------------------------------------------------
create or replace view public.v_pending_executions
with (security_invoker = true) as
select
  v.id as advice_item_id,
  v.client_id,
  c.client_code,
  c.full_name as client_name,
  v.advisor_id,
  pr.full_name as advisor_name,
  v.batch_code,
  v.security_id,
  v.scheme_name,
  v.action,
  v.quantity_basis,
  v.advised_amount,
  v.advised_units,
  v.executed_amount,
  v.executed_units,
  v.pending_amount,
  v.pending_units,
  v.status,
  v.communicated_at,
  v.communication_channel,
  v.valid_until,
  v.age_days,
  v.plan_item_id
from public.v_advice_items v
join public.clients c on c.id = v.client_id
left join public.profiles pr on pr.id = v.advisor_id
where v.is_open;

-- -----------------------------------------------------------------------------
-- SIP progress per client (active plan)
-- -----------------------------------------------------------------------------
create or replace view public.v_sip_summary
with (security_invoker = true) as
select
  s.client_id,
  s.plan_id,
  count(*) filter (where s.action = 'STOP' and s.status <> 'CANCELLED') as sips_to_stop,
  count(*) filter (where s.action = 'STOP' and s.status = 'COMPLETED') as sips_stopped,
  count(*) filter (where s.action in ('START', 'CHANGE') and s.status <> 'CANCELLED') as sips_to_start,
  count(*) filter (where s.action in ('START', 'CHANGE') and s.status = 'COMPLETED') as sips_started,
  count(*) filter (where s.status in ('PLANNED', 'ADVISED')) as pending_sip_actions,
  coalesce(sum(s.old_amount) filter (where s.action = 'STOP' and s.status <> 'CANCELLED'), 0) as stop_amount,
  coalesce(sum(s.new_amount) filter (where s.action in ('START', 'CHANGE') and s.status <> 'CANCELLED'), 0) as start_amount
from public.sip_plan_items s
join public.advisory_plans p on p.id = s.plan_id and p.status = 'ACTIVE'
group by s.client_id, s.plan_id;

-- -----------------------------------------------------------------------------
-- Command Centre metrics for a given IST day (defaults to today).
-- SECURITY INVOKER: returns only what the caller may see.
-- -----------------------------------------------------------------------------
create or replace function public.command_centre_metrics(p_day date default null)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with d as (select coalesce(p_day, app.today_ist()) as day),
  today_advice as (
    select v.*
    from public.v_advice_items v, d
    where (v.communicated_at at time zone 'Asia/Kolkata')::date = d.day
  ),
  today_exec as (
    select e.*
    from public.executions e, d
    where e.execution_date = d.day and e.status in ('EXECUTED', 'PARTIAL')
  )
  select jsonb_build_object(
    'day', (select day from d),
    'total_clients', (select count(*) from public.clients where deleted_at is null and status <> 'CLOSED'),
    'total_portfolio_value', (select coalesce(sum(total_current_value), 0) from public.v_latest_snapshot),
    'active_plans', (select count(*) from public.advisory_plans where status = 'ACTIVE'),
    'calls_issued_today', (select count(distinct advice_batch_id) from today_advice),
    'advice_items_today', (select count(*) from today_advice),
    'sell_advised_today', (select coalesce(sum(advised_amount), 0) from today_advice where action in ('SELL', 'SWITCH')),
    'buy_advised_today', (select coalesce(sum(advised_amount), 0) from today_advice where action = 'BUY'),
    'executed_value_today', (select coalesce(sum(executed_amount), 0) from today_exec),
    'pending_value_total', (select coalesce(sum(pending_amount), 0) from public.v_advice_items where is_open),
    'pending_executions', (select count(*) from public.v_advice_items where status = 'ISSUED'),
    'partial_executions', (select count(*) from public.v_advice_items where status = 'PARTIALLY_EXECUTED'),
    'stale_pending_executions', (select count(*) from public.v_advice_items where is_open and age_days > 3),
    'cas_mismatches', (
      select count(*) from public.reconciliation_matches m
      join public.reconciliation_runs r on r.id = m.run_id and r.status = 'OPEN'
      where m.status = 'SUGGESTED'),
    'unadvised_activity', (
      select count(*) from public.reconciliation_matches
      where status = 'UNEXPLAINED' and classification = 'UNADVISED' and reviewed_at is null),
    'cas_needs_review', (
      select count(*) from public.cas_documents where parse_status in ('NEEDS_REVIEW', 'FAILED'))
      + (select count(*) from public.portfolio_snapshots where review_status = 'PENDING_REVIEW'),
    'draft_plans', (select count(*) from public.advisory_plans where status = 'DRAFT'),
    'review_due', (
      select count(*) from public.clients, d
      where deleted_at is null and status <> 'CLOSED'
        and next_review_date is not null and next_review_date <= d.day + 7),
    'follow_ups_due', (
      select count(*) from public.client_notes, d
      where deleted_at is null and follow_up_done_at is null
        and follow_up_date is not null and follow_up_date <= d.day)
  )
$$;
