-- =============================================================================
-- Speed: the effective type of a CAS transaction, stored.
--
-- v_sip_instalments (20261027000035) read every transaction's type through
-- txn_effective_type() (a dozen regular expressions) on every query, and it
-- sits under v_sip_item_progress -> v_client_sip -> the Clients list and the
-- home screen: ~150-200 ms per page load for a few thousand transactions,
-- growing with every CAS.
--
-- The type is now a stored generated column, computed once when a transaction
-- is written. txn_effective_type() is immutable and stays the single rule; if
-- it is ever redefined, a migration must rewrite the column too
-- (update public.portfolio_transactions set description = description).
-- =============================================================================

alter table public.portfolio_transactions
  add column effective_type text generated always as (public.txn_effective_type(transaction_type, description, units)) stored;

create index if not exists portfolio_transactions_client_type_idx
  on public.portfolio_transactions (client_id, effective_type);

create or replace view public.v_sip_instalments
with (security_invoker = true) as
with tx as (
  select t.id, t.client_id, t.security_id, t.transaction_date as d, t.amount, t.units, t.description,
         t.effective_type as et,
         -- The fund and folio a SIP runs in (the part of a folio after "/" is a check digit).
         coalesce(t.isin, sm.isin, lower(t.scheme_name)) || '|' || lower(regexp_replace(split_part(coalesce(t.folio_number, ''), '/', 1), '[^0-9a-zA-Z]', '', 'g')) as fund,
         round(abs(t.amount) / 50) * 50 as amt
  from public.portfolio_transactions t
  left join public.security_master sm on sm.id = t.security_id
  -- Only what the rule looks at: purchases, and the rejections / reversals that may bounce one.
  where (t.amount > 0 and t.units > 0 and t.effective_type in ('SIP', 'PURCHASE'))
     or ((coalesce(t.units, 0) < 0 or coalesce(t.amount, 0) < 0) and coalesce(t.description, '') ~* '(reject|revers|bounce|return)')
), buys as (
  select * from tx where amount > 0 and units > 0 and et in ('SIP', 'PURCHASE')
), seq as (
  select b.*, b.d - lag(b.d) over (partition by b.client_id, b.fund, b.amt order by b.d) as gap from buys b where b.et = 'PURCHASE'
), runs as (
  select s.*, sum(case when s.gap is null or s.gap < 20 or s.gap > 40 then 1 else 0 end)
              over (partition by s.client_id, s.fund, s.amt order by s.d rows unbounded preceding) as run_no
  from seq s
), sized as (
  select r.*, count(*) over (partition by r.client_id, r.fund, r.amt, r.run_no) as run_len from runs r
), bounced as (
  -- A rejection / reversal / bounce of the same amount within 15 days takes back the latest instalment before it.
  select distinct on (x.id) b.id as buy_id
  from tx x
  join buys b on b.client_id = x.client_id and b.fund = x.fund and b.amt = x.amt
   and b.d between x.d - 15 and x.d
  where (coalesce(x.units, 0) < 0 or coalesce(x.amount, 0) < 0)
    and coalesce(x.description, '') ~* '(reject|revers|bounce|return)'
  order by x.id, b.d desc
)
select b.id as transaction_id, b.client_id, b.security_id, b.d as transaction_date, abs(b.amount) as amount, b.units
from buys b
where (b.et = 'SIP' or b.id in (select id from sized where run_len >= 3))
  and b.id not in (select buy_id from bounced);

comment on view public.v_sip_instalments is
  'Transactions that are SIP instalments: explicit SIP rows plus monthly runs (3+, same amount to ₹50, 20-40 days apart) of plain purchases in one fund and folio, less instalments bounced by a same-amount rejection within 15 days. Same rule as instalments() in lib/domain/sip-status.ts. Reads the stored effective_type.';
