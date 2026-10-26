-- =============================================================================
-- 0051 One CAS transaction, stored once
--
-- The same transaction read from two overlapping CAS files was stored twice when an
-- older reader labelled it PURCHASE and a newer one SIP: the label was part of the
-- de-duplication hash. Same folio, fund, date, units, amount and balance after the
-- trade is the same transaction (the balance tells two real trades apart).
--
-- 1. Repair: each duplicate is copied to portfolio_transactions_removed (so it can be
--    restored), its snapshot links move to the copy that stays, and it is removed.
--    Nothing else points at the duplicates (no CAS match, no execution).
-- 2. Prevention: a unique index on those fields; inserts skip any row it rejects.
-- =============================================================================

select set_config('app.audit_reason', 'Remove duplicate CAS transactions (same trade stored twice under two type labels)', true);

create table if not exists public.portfolio_transactions_removed (
  like public.portfolio_transactions,
  kept_id    uuid not null,
  removed_at timestamptz not null default now()
);
alter table public.portfolio_transactions_removed enable row level security;
revoke all on public.portfolio_transactions_removed from anon, authenticated;
grant all on public.portfolio_transactions_removed to service_role;

create temporary table dup_pairs as
with g as (
  select array_agg(id order by created_at, id) as ids
  from public.portfolio_transactions
  where units is not null and amount is not null and amount <> 0
  group by client_id, coalesce(folio_number, ''), coalesce(isin, lower(scheme_name)), transaction_date, units, amount, coalesce(balance_units, -1)
  having count(*) > 1
)
select ids[1] as keep_id, unnest(ids[2:]) as drop_id from g;

insert into public.portfolio_transactions_removed
select t.*, p.keep_id, now() from public.portfolio_transactions t join dup_pairs p on p.drop_id = t.id;

-- Every snapshot that read a duplicate now lists the copy that stays.
insert into public.portfolio_snapshot_transactions (snapshot_id, transaction_id, client_id)
select l.snapshot_id, p.keep_id, l.client_id
from public.portfolio_snapshot_transactions l join dup_pairs p on p.drop_id = l.transaction_id
on conflict do nothing;
delete from public.portfolio_snapshot_transactions l using dup_pairs p where l.transaction_id = p.drop_id;

update public.reconciliation_matches m set cas_transaction_id = p.keep_id
from dup_pairs p where m.cas_transaction_id = p.drop_id;

alter table public.portfolio_transactions disable trigger portfolio_transactions_no_delete;
delete from public.portfolio_transactions t using dup_pairs p where t.id = p.drop_id;
alter table public.portfolio_transactions enable trigger portfolio_transactions_no_delete;

create unique index if not exists portfolio_transactions_same_trade
  on public.portfolio_transactions (client_id, coalesce(folio_number, ''), coalesce(isin, lower(scheme_name)), transaction_date, units, amount, coalesce(balance_units, -1))
  where units is not null and amount is not null and amount <> 0;
