-- =============================================================================
-- MN Advisory Dashboard — 0003 CAS documents, snapshots, holdings, transactions
--
-- A CAS is EVIDENCE of holdings. Every CAS produces a new snapshot; snapshots
-- are never overwritten. Snapshots produced by automated/AI extraction start as
-- PENDING_REVIEW and must be confirmed by a person before they drive metrics
-- or reconciliation.
-- =============================================================================

create table public.cas_documents (
  id                   uuid primary key default gen_random_uuid(),
  client_id            uuid not null references public.clients (id),
  document_id          uuid not null unique references public.documents (id),
  file_path            text not null,
  file_sha256          text not null,
  statement_from_date  date,
  statement_to_date    date,
  valuation_date       date,
  uploaded_at          timestamptz not null default now(),
  parse_status         text not null default 'UPLOADED' check (parse_status in (
                         'UPLOADED', 'PROCESSING', 'PARSED', 'NEEDS_REVIEW', 'FAILED')),
  parse_error          text,
  parse_warnings       jsonb not null default '[]'::jsonb,
  processing_started_at timestamptz,
  parsed_at            timestamptz,
  source               text not null default 'OTHER' check (source in (
                         'CAMS', 'KFINTECH', 'NSDL', 'CDSL', 'MF_CENTRAL', 'MANUAL', 'OTHER')),
  -- Only a flag. The password itself is NEVER stored (it is passed through to
  -- the extraction webhook in-memory, once).
  password_protected   boolean not null default false,
  investor_name        text,
  investor_pan         text,
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  created_by           uuid references public.profiles (id),
  check (statement_from_date is null or statement_to_date is null
         or statement_from_date <= statement_to_date)
);

create unique index cas_documents_dedupe on public.cas_documents (client_id, file_sha256);
create index cas_documents_client_idx on public.cas_documents (client_id, uploaded_at desc);
create index cas_documents_status_idx on public.cas_documents (parse_status);

create trigger cas_documents_touch_updated_at
  before update on public.cas_documents
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
create table public.portfolio_snapshots (
  id                    uuid primary key default gen_random_uuid(),
  client_id             uuid not null references public.clients (id),
  cas_document_id       uuid unique references public.cas_documents (id),
  snapshot_date         date not null,
  total_invested_value  numeric(18,2) not null default 0,
  total_current_value   numeric(18,2) not null default 0,
  total_gain_loss       numeric(18,2) generated always as (total_current_value - total_invested_value) stored,
  source                text not null default 'CAS' check (source in ('CAS', 'MANUAL', 'IMPORT', 'SEED')),
  extraction_method     text not null default 'MANUAL' check (extraction_method in (
                          'MANUAL', 'AI_EXTRACTION', 'DETERMINISTIC_PARSER', 'SEED')),
  review_status         text not null default 'PENDING_REVIEW' check (review_status in (
                          'PENDING_REVIEW', 'CONFIRMED', 'REJECTED')),
  reviewed_at           timestamptz,
  reviewed_by           uuid references public.profiles (id),
  review_note           text,
  is_baseline           boolean not null default false,
  holdings_count        integer not null default 0,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by            uuid references public.profiles (id),
  check (review_status = 'PENDING_REVIEW' or reviewed_at is not null),
  check (not is_baseline or review_status = 'CONFIRMED')
);

create index portfolio_snapshots_client_date_idx
  on public.portfolio_snapshots (client_id, snapshot_date desc, created_at desc);
create index portfolio_snapshots_status_idx on public.portfolio_snapshots (review_status);
create unique index portfolio_snapshots_one_baseline
  on public.portfolio_snapshots (client_id) where is_baseline;

create trigger portfolio_snapshots_touch_updated_at
  before update on public.portfolio_snapshots
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
create table public.portfolio_holdings (
  id               uuid primary key default gen_random_uuid(),
  snapshot_id      uuid not null references public.portfolio_snapshots (id),
  client_id        uuid not null references public.clients (id),
  security_id      uuid references public.security_master (id),
  scheme_name      text not null,
  amc              text,
  folio_number     text,
  isin             text,
  plan_type        text check (plan_type in ('DIRECT', 'REGULAR')),
  category         text,
  units            numeric(20,4) not null check (units >= 0),
  cost_value       numeric(18,2),
  current_value    numeric(18,2) not null check (current_value >= 0),
  latest_nav       numeric(18,4),
  latest_nav_date  date,
  created_at       timestamptz not null default now()
);

create index portfolio_holdings_snapshot_idx on public.portfolio_holdings (snapshot_id);
create index portfolio_holdings_security_idx on public.portfolio_holdings (security_id);
create index portfolio_holdings_client_idx on public.portfolio_holdings (client_id);
create unique index portfolio_holdings_unique_line
  on public.portfolio_holdings (snapshot_id, coalesce(folio_number, ''), coalesce(isin, scheme_name));

-- -----------------------------------------------------------------------------
create table public.portfolio_transactions (
  id                   uuid primary key default gen_random_uuid(),
  client_id            uuid not null references public.clients (id),
  source_snapshot_id   uuid not null references public.portfolio_snapshots (id),
  security_id          uuid references public.security_master (id),
  transaction_date     date not null,
  transaction_type     text not null check (transaction_type in (
                         'PURCHASE', 'SIP', 'REDEMPTION', 'SWITCH_IN', 'SWITCH_OUT',
                         'DIVIDEND_PAYOUT', 'DIVIDEND_REINVESTMENT', 'BONUS', 'MERGER',
                         'STAMP_DUTY', 'STT', 'TDS', 'OTHER')),
  scheme_name          text not null,
  isin                 text,
  folio_number         text,
  units                numeric(20,4),
  nav                  numeric(18,4),
  amount               numeric(18,2),
  balance_units        numeric(20,4),
  description          text,
  -- Consecutive CAS statements overlap; the same transaction is stored once.
  dedupe_hash          text not null,
  created_at           timestamptz not null default now()
);

create unique index portfolio_transactions_dedupe on public.portfolio_transactions (client_id, dedupe_hash);
create index portfolio_transactions_client_date_idx on public.portfolio_transactions (client_id, transaction_date desc);
create index portfolio_transactions_snapshot_idx on public.portfolio_transactions (source_snapshot_id);
create index portfolio_transactions_security_idx on public.portfolio_transactions (security_id);
