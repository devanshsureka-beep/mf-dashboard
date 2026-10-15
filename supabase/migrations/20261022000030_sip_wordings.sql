-- =============================================================================
-- SIP instalments the older CAS reader stored as plain purchases.
-- RTAs word SIP instalments many ways ("Sys. Investment", "Systematic Purchase
-- - Instalment 3/12", "Purchase Systematic-BSE", "Purchase Ongoing
-- Systematic", "Purchase Instalment No"); the reader only knew "SIP" and
-- "Systematic Investment", so these became lump-sum PURCHASEs: SIP progress
-- missed them and they read as buys. Stored transactions are immutable, so
-- the type is corrected where it is read: public.txn_effective_type() (the
-- same rule as effectiveTxnType() in lib/parsers/cas.ts).
-- v_sip_item_progress: same columns as 0018.
-- =============================================================================

create or replace function public.txn_effective_type(p_type text, p_description text, p_units numeric)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when coalesce(p_units, 0) <> 0
     and p_type in ('PURCHASE', 'SIP', 'STAMP_DUTY', 'STT', 'TDS', 'OTHER')
     and coalesce(p_description, '') ~* '(\msip\M|sip[[:space:]-]*purchase|purchase[[:space:]-]*sip|sys\.?[[:space:]]*invest|systematic[[:space:]]*(investment|purchase|instal)|purchase[[:space:]-]*(ongoing[[:space:]]*)?systematic|purchase[[:space:]-]*instal)'
     and coalesce(p_description, '') !~* '(cancel|revers|reject)'
    then 'SIP'
    else p_type
  end
$$;

comment on function public.txn_effective_type(text, text, numeric) is
  'The type a CAS transaction is used as: SIP instalments stored by an older reader as PURCHASE (or a tax line with units) count as SIP. Mirrors effectiveTxnType() in lib/parsers/cas.ts.';

grant execute on function public.txn_effective_type(text, text, numeric) to authenticated;

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
    and public.txn_effective_type(t.transaction_type, t.description, t.units) = 'SIP'
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

grant select on public.v_sip_item_progress to authenticated;
