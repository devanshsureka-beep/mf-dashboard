-- =============================================================================
-- SIP progress from the report date. Plans are often approved weeks after the
-- report, and clients start / change / stop SIPs on the report meanwhile; the
-- instalments in between were not counted. A line now counts from the
-- earlier of the advice / approval date and the plan (report) date; a CHANGE
-- line counts only instalments at its new amount. Same columns as 0030.
-- =============================================================================

create or replace view public.v_sip_item_progress
with (security_invoker = true) as
with lines as (
  select s.*, p.status as plan_status,
         -- From the report date when that is earlier than the advice / approval:
         -- clients often start or change a SIP on the report before the plan is approved.
         least(coalesce((s.advised_at at time zone 'Asia/Kolkata')::date,
                        (p.approved_at at time zone 'Asia/Kolkata')::date,
                        (s.created_at at time zone 'Asia/Kolkata')::date),
               p.plan_date) as since
  from public.sip_plan_items s
  join public.advisory_plans p on p.id = s.plan_id
), txns as (
  select t.id, t.client_id, t.security_id, t.transaction_date, abs(t.amount) as amount
  from public.portfolio_transactions t
  where coalesce(t.amount, 0) <> 0 and t.security_id is not null
    and public.txn_effective_type(t.transaction_type, t.description, t.units) = 'SIP'
), owned as (
  select distinct on (l.plan_id, t.id) l.id as line_id, t.amount, t.transaction_date
  from txns t
  join lines l on l.client_id = t.client_id and l.security_id = t.security_id
              and l.action in ('START', 'CHANGE') and l.status <> 'CANCELLED' and l.since <= t.transaction_date
              -- A changed SIP counts only instalments at the new amount (not the old SIP still running).
              and (l.action = 'START' or l.new_amount is null
                   or abs(t.amount - l.new_amount) <= greatest(50, l.new_amount * 0.05))
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

grant select on public.v_sip_item_progress to authenticated;
