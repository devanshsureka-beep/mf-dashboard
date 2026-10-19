-- Which transactions each CAS contains.
-- A transaction is stored once per client (deduplicated by its hash) and kept on the snapshot that
-- first read it. A second copy of the same statement (a re-download after the first was rejected,
-- or left unchecked) then had no transactions of its own: its calls could not be matched by
-- transaction. Every snapshot now lists the transactions it read, old or new.
-- A transaction only rejected snapshots read (e.g. someone else's statement) no longer counts.

create table public.portfolio_snapshot_transactions (
  snapshot_id    uuid not null references public.portfolio_snapshots (id),
  transaction_id uuid not null references public.portfolio_transactions (id),
  client_id      uuid not null references public.clients (id),
  primary key (snapshot_id, transaction_id)
);
create index portfolio_snapshot_transactions_txn_idx on public.portfolio_snapshot_transactions (transaction_id);
create index portfolio_snapshot_transactions_client_idx on public.portfolio_snapshot_transactions (client_id);

insert into public.portfolio_snapshot_transactions (snapshot_id, transaction_id, client_id)
select t.source_snapshot_id, t.id, t.client_id from public.portfolio_transactions t
on conflict do nothing;

alter table public.portfolio_snapshot_transactions enable row level security;
create policy portfolio_snapshot_transactions_select on public.portfolio_snapshot_transactions
  for select to authenticated using (client_id = any ((select app.accessible_client_ids())::uuid[]));
create policy portfolio_snapshot_transactions_insert on public.portfolio_snapshot_transactions
  for insert to authenticated with check (app.can_operate_client(client_id));
grant select, insert on public.portfolio_snapshot_transactions to authenticated;

-- Transactions read by at least one snapshot that was not rejected.
create or replace view public.v_cas_transactions
with (security_invoker = true) as
select t.*
from public.portfolio_transactions t
where exists (
  select 1 from public.portfolio_snapshot_transactions l
  join public.portfolio_snapshots s on s.id = l.snapshot_id
  where l.transaction_id = t.id and s.review_status <> 'REJECTED');
grant select on public.v_cas_transactions to authenticated;

-- Same SIP rule as before, over those transactions only.
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

