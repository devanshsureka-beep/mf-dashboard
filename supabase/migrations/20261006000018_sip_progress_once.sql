-- =============================================================================
-- SIP progress: each SIP instalment counts once. Within a plan it belongs to the
-- most recent SIP line (start / change) for that fund whose start date is on or
-- before the instalment, so two lines on one fund no longer both claim it.
-- Rows an older CAS reader stored as a tax line ("SIP … Stamp Duty" with units)
-- count as SIP instalments too. Dates are IST. Same columns as 0016.
-- =============================================================================

create or replace view public.v_sip_item_progress
with (security_invoker = true) as
with lines as (
  select s.*, p.status as plan_status,
         coalesce((s.advised_at at time zone 'Asia/Kolkata')::date,
                  (p.approved_at at time zone 'Asia/Kolkata')::date,
                  (s.created_at at time zone 'Asia/Kolkata')::date) as since
  from public.sip_plan_items s
  join public.advisory_plans p on p.id = s.plan_id
), txns as (
  select t.id, t.client_id, t.security_id, t.transaction_date, abs(t.amount) as amount
  from public.portfolio_transactions t
  where coalesce(t.amount, 0) <> 0 and t.security_id is not null
    and (t.transaction_type = 'SIP'
         or (t.transaction_type in ('STAMP_DUTY', 'STT', 'TDS') and coalesce(t.units, 0) <> 0
             and coalesce(t.description, '') ~* '(\msip\M|systematic investment)'))
), owned as (
  select distinct on (l.plan_id, t.id) l.id as line_id, t.amount, t.transaction_date
  from txns t
  join lines l on l.client_id = t.client_id and l.security_id = t.security_id
              and l.action in ('START', 'CHANGE') and l.status <> 'CANCELLED' and l.since <= t.transaction_date
  order by l.plan_id, t.id, l.since desc, l.created_at desc
), per_line as (
  select line_id, sum(amount) as amount, count(*) as instalments, max(transaction_date) as last_date
  from owned group by line_id
)
select
  l.id as sip_item_id,
  l.plan_id,
  l.client_id,
  l.plan_status,
  l.security_id,
  l.scheme_name,
  l.action,
  l.status as item_status,
  l.frequency,
  l.old_amount,
  l.new_amount,
  (case when l.action = 'STOP' then 0 else coalesce(l.new_amount, 0) end)::numeric(18,2) as monthly_amount,
  l.since as since_date,
  coalesce(pl.amount, 0)::numeric(18,2) as invested_amount,
  coalesce(pl.instalments, 0) as instalments,
  pl.last_date as last_instalment_date
from lines l
left join per_line pl on pl.line_id = l.id;

comment on view public.v_sip_item_progress is
  'SIP plan lines: monthly amount and what SIP instalments seen in CAS have invested since the line was advised (or the plan approved); each instalment counts for one line. No projection.';

grant select on public.v_sip_item_progress to authenticated;
