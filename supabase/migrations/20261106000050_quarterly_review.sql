-- =============================================================================
-- 0050 Quarterly review (the "69 report")
--
-- 1. nav_history: past NAVs by AMFI code (fund and index-fund history), fetched on
--    demand when a review is built and topped up by the daily NAV feed for every
--    code already tracked. Reference data, like mf_schemes: no audit trail.
-- 2. benchmark_indices: each index the report compares with, priced through a
--    Direct-plan index fund (so the comparison carries real costs).
-- 3. fund_benchmarks: the index a fund is compared with when the advisor overrides
--    the default picked from its category.
-- 4. market_context: the quarter's index valuations, shared by every client's review.
-- 5. quarterly_reviews: one per client and quarter, with the advisor's inputs;
--    quarterly_review_files: every PDF downloaded (kept in private storage).
-- =============================================================================

create table public.nav_history (
  amfi_code  text not null,
  nav_date   date not null,
  nav        numeric(18,6) not null check (nav > 0),
  primary key (amfi_code, nav_date)
);

create table public.nav_history_fetches (
  amfi_code   text primary key,
  fetched_at  timestamptz not null default now(),
  first_date  date,
  last_date   date,
  rows_stored integer not null default 0,
  error       text
);

create table public.benchmark_indices (
  code          text primary key check (code ~ '^[A-Z0-9_]+$'),
  name          text not null,
  index_fund_amfi_code text not null,
  sort          integer not null default 0
);

insert into public.benchmark_indices (code, name, index_fund_amfi_code, sort) values
  ('NIFTY50',        'Nifty 50',                '119063', 1),  -- HDFC Nifty 50 Index Fund, Direct, Growth
  ('NIFTY100',       'Nifty 100',               '147666', 2),  -- Axis Nifty 100 Index Fund, Direct, Growth
  ('NIFTYNEXT50',    'Nifty Next 50',           '120684', 3),  -- ICICI Pru Nifty Next 50 Index Fund, Direct, Growth
  ('NIFTY500',       'Nifty 500',               '147625', 4),  -- Motilal Oswal Nifty 500 Index Fund, Direct, Growth
  ('LARGEMIDCAP250', 'Nifty LargeMidcap 250',   '149343', 5),  -- Edelweiss Nifty Large Midcap 250 Index Fund, Direct, Growth
  ('MIDCAP150',      'Nifty Midcap 150',        '147622', 6),  -- Motilal Oswal Nifty Midcap 150 Index Fund, Direct, Growth
  ('SMALLCAP250',    'Nifty Smallcap 250',      '147623', 7),  -- Motilal Oswal Nifty Smallcap 250 Index Fund, Direct, Growth
  ('NIFTYBANK',      'Nifty Bank',              '147620', 8)   -- Motilal Oswal Nifty Bank Index Fund, Direct, Growth
on conflict (code) do nothing;

create table public.fund_benchmarks (
  isin        text primary key check (isin ~ '^[A-Z]{2}[A-Z0-9]{9}[0-9]$'),
  index_code  text references public.benchmark_indices (code),  -- null = no index comparison for this fund
  set_by      uuid references public.profiles (id),
  set_at      timestamptz not null default now()
);

create table public.market_context (
  quarter_end date primary key,
  data        jsonb not null default '{}'::jsonb,
  updated_by  uuid references public.profiles (id),
  updated_at  timestamptz not null default now()
);

create table public.quarterly_reviews (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references public.clients (id),
  quarter_end  date not null check (extract(day from quarter_end + 1) = 1 and extract(month from quarter_end) in (3, 6, 9, 12)),
  inputs       jsonb not null default '{}'::jsonb,
  created_by   uuid references public.profiles (id),
  created_at   timestamptz not null default now(),
  updated_by   uuid references public.profiles (id),
  updated_at   timestamptz not null default now(),
  unique (client_id, quarter_end)
);

create table public.quarterly_review_files (
  id           uuid primary key default gen_random_uuid(),
  review_id    uuid not null references public.quarterly_reviews (id),
  client_id    uuid not null references public.clients (id),
  file_path    text not null,
  file_name    text not null,
  size_bytes   bigint not null check (size_bytes >= 0),
  sha256       text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  as_of        date not null,
  created_by   uuid references public.profiles (id),
  created_at   timestamptz not null default now()
);
create index quarterly_review_files_review_idx on public.quarterly_review_files (review_id, created_at desc);

create trigger quarterly_reviews_touch_updated_at before update on public.quarterly_reviews
  for each row execute function app.touch_updated_at();
create trigger quarterly_reviews_audit after insert or update or delete on public.quarterly_reviews
  for each row execute function app.audit_row_change();
create trigger quarterly_reviews_no_delete before delete on public.quarterly_reviews
  for each row execute function app.forbid_delete();
create trigger quarterly_review_files_audit after insert or update or delete on public.quarterly_review_files
  for each row execute function app.audit_row_change();
create trigger quarterly_review_files_no_delete before delete on public.quarterly_review_files
  for each row execute function app.forbid_delete();

-- Reference data: every staff member reads it; NAVs are written while building a review.
alter table public.nav_history enable row level security;
alter table public.nav_history_fetches enable row level security;
alter table public.benchmark_indices enable row level security;
alter table public.fund_benchmarks enable row level security;
alter table public.market_context enable row level security;
alter table public.quarterly_reviews enable row level security;
alter table public.quarterly_review_files enable row level security;

revoke all on public.nav_history, public.nav_history_fetches, public.benchmark_indices, public.fund_benchmarks,
  public.market_context, public.quarterly_reviews, public.quarterly_review_files from anon, authenticated;
grant select, insert, update on public.nav_history, public.nav_history_fetches to authenticated;
grant select on public.benchmark_indices to authenticated;
grant select, insert, update on public.fund_benchmarks, public.market_context, public.quarterly_reviews to authenticated;
grant delete on public.fund_benchmarks to authenticated;
grant select, insert on public.quarterly_review_files to authenticated;
grant all on public.nav_history, public.nav_history_fetches, public.benchmark_indices, public.fund_benchmarks,
  public.market_context, public.quarterly_reviews, public.quarterly_review_files to service_role;

create policy nav_history_select on public.nav_history for select to authenticated using ((select app.is_staff()));
create policy nav_history_insert on public.nav_history for insert to authenticated with check ((select app.is_staff()));
create policy nav_history_update on public.nav_history for update to authenticated using ((select app.is_staff())) with check ((select app.is_staff()));
create policy nav_history_fetches_select on public.nav_history_fetches for select to authenticated using ((select app.is_staff()));
create policy nav_history_fetches_insert on public.nav_history_fetches for insert to authenticated with check ((select app.is_staff()));
create policy nav_history_fetches_update on public.nav_history_fetches for update to authenticated using ((select app.is_staff())) with check ((select app.is_staff()));
create policy benchmark_indices_select on public.benchmark_indices for select to authenticated using ((select app.is_staff()));

-- Advisors and admins write the advice-side inputs.
create policy fund_benchmarks_select on public.fund_benchmarks for select to authenticated using ((select app.is_staff()));
create policy fund_benchmarks_insert on public.fund_benchmarks for insert to authenticated
  with check ((select app.user_role()) in ('ADMIN', 'ADVISOR') and set_by = (select auth.uid()));
create policy fund_benchmarks_update on public.fund_benchmarks for update to authenticated
  using ((select app.user_role()) in ('ADMIN', 'ADVISOR')) with check ((select app.user_role()) in ('ADMIN', 'ADVISOR'));
create policy fund_benchmarks_delete on public.fund_benchmarks for delete to authenticated
  using ((select app.user_role()) in ('ADMIN', 'ADVISOR'));
create policy market_context_select on public.market_context for select to authenticated using ((select app.is_staff()));
create policy market_context_insert on public.market_context for insert to authenticated
  with check ((select app.user_role()) in ('ADMIN', 'ADVISOR') and updated_by = (select auth.uid()));
create policy market_context_update on public.market_context for update to authenticated
  using ((select app.user_role()) in ('ADMIN', 'ADVISOR')) with check ((select app.user_role()) in ('ADMIN', 'ADVISOR'));

create policy quarterly_reviews_select on public.quarterly_reviews for select to authenticated using (app.can_access_client(client_id));
create policy quarterly_reviews_insert on public.quarterly_reviews for insert to authenticated
  with check (app.can_advise_client(client_id) and created_by = (select auth.uid()));
create policy quarterly_reviews_update on public.quarterly_reviews for update to authenticated
  using (app.can_advise_client(client_id)) with check (app.can_advise_client(client_id));
create policy quarterly_review_files_select on public.quarterly_review_files for select to authenticated using (app.can_access_client(client_id));
create policy quarterly_review_files_insert on public.quarterly_review_files for insert to authenticated
  with check (app.can_advise_client(client_id) and created_by = (select auth.uid()));
