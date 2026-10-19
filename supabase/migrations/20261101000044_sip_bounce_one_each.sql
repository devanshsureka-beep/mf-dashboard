-- SIP instalments: each bounce takes back its own purchase.
-- Before, every reversal took back the latest matching purchase, so two SIPs of the same amount
-- bounced on the same day (or a second bounce soon after) took back the same purchase twice and one
-- bounced instalment still counted as paid. The pick also depended on row order. Now each reversal
-- takes back a different purchase, in a fixed order, as the app's own rule does.

create or replace function app.sip_bounced_buys()
returns setof uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  r record;
  taken uuid[] := '{}';
  done_rev uuid := null;
begin
  -- Each rejection / reversal / bounce takes back ONE purchase: the latest one of the same fund, folio
  -- and amount within 15 days before it that no earlier reversal took (as bouncedPurchases in
  -- lib/domain/sip-status.ts). Two SIPs bounced on the same day take back two purchases.
  for r in
    with tx as (
      select t.id, t.client_id, t.security_id, t.transaction_date as d, t.amount, t.units, t.description,
             t.effective_type as et,
             -- The fund and folio a SIP runs in (the part of a folio after "/" is a check digit).
             coalesce(t.isin, sm.isin, lower(t.scheme_name)) || '|' || lower(regexp_replace(split_part(coalesce(t.folio_number, ''), '/', 1), '[^0-9a-zA-Z]', '', 'g')) as fund,
             round(abs(t.amount) / 50) * 50 as amt
      from public.v_cas_transactions t
      left join public.security_master sm on sm.id = t.security_id
      -- Only what the rule looks at: purchases, and the rejections / reversals that may bounce one.
      where (t.amount > 0 and t.units > 0 and t.effective_type in ('SIP', 'PURCHASE'))
         or ((coalesce(t.units, 0) < 0 or coalesce(t.amount, 0) < 0) and coalesce(t.description, '') ~* '(reject|revers|bounce|return)')
    ), buys as (
      select * from tx where amount > 0 and units > 0 and et in ('SIP', 'PURCHASE')
    )
    select x.id as rev_id, b.id as buy_id
    from tx x
    join buys b on b.client_id = x.client_id and b.fund = x.fund and b.amt = x.amt and b.d between x.d - 15 and x.d
    where (coalesce(x.units, 0) < 0 or coalesce(x.amount, 0) < 0)
      and coalesce(x.description, '') ~* '(reject|revers|bounce|return)'
    order by x.client_id, x.d, x.id, b.d desc, b.id
  loop
    continue when r.rev_id = done_rev or r.buy_id = any (taken);
    taken := taken || r.buy_id;
    done_rev := r.rev_id;
    return next r.buy_id;
  end loop;
end;
$$;
grant execute on function app.sip_bounced_buys() to authenticated;

create or replace view public.v_sip_instalments
with (security_invoker = true) as
with tx as (
  select t.id, t.client_id, t.security_id, t.transaction_date as d, t.amount, t.units, t.description,
         t.effective_type as et,
         -- The fund and folio a SIP runs in (the part of a folio after "/" is a check digit).
         coalesce(t.isin, sm.isin, lower(t.scheme_name)) || '|' || lower(regexp_replace(split_part(coalesce(t.folio_number, ''), '/', 1), '[^0-9a-zA-Z]', '', 'g')) as fund,
         round(abs(t.amount) / 50) * 50 as amt
  from public.v_cas_transactions t
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
)
select b.id as transaction_id, b.client_id, b.security_id, b.d as transaction_date, abs(b.amount) as amount, b.units
from buys b
where (b.et = 'SIP' or b.id in (select id from sized where run_len >= 3))
  and b.id not in (select app.sip_bounced_buys());

