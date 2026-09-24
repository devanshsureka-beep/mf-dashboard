-- =============================================================================
-- MN Advisory Dashboard — 0002 Clients, assignments, security master, documents
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Clients
-- -----------------------------------------------------------------------------
create sequence public.client_code_seq start with 101;

create table public.clients (
  id               uuid primary key default gen_random_uuid(),
  -- Human-readable ID, e.g. MN-00241. Generated, never reused.
  client_code      text not null unique
                   default ('MN-' || lpad(nextval('public.client_code_seq')::text, 5, '0')),
  full_name        text not null check (length(trim(full_name)) > 0),
  email            text,
  phone            text,
  pan              text check (pan is null or pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  onboarding_date  date not null default app.today_ist(),
  risk_profile     text check (risk_profile in (
                     'CONSERVATIVE', 'MODERATELY_CONSERVATIVE', 'MODERATE',
                     'MODERATELY_AGGRESSIVE', 'AGGRESSIVE')),
  goal             text,
  status           text not null default 'ONBOARDING'
                   check (status in ('PROSPECT', 'ONBOARDING', 'ACTIVE', 'DORMANT', 'CLOSED')),
  next_review_date date,
  notes            text,
  deleted_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references public.profiles (id)
);

create index clients_status_idx on public.clients (status) where deleted_at is null;
create index clients_created_at_idx on public.clients (created_at);
create index clients_full_name_idx on public.clients (lower(full_name));
create unique index clients_pan_unique on public.clients (pan) where pan is not null and deleted_at is null;

create trigger clients_touch_updated_at
  before update on public.clients
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Advisor / operations assignments (source of truth for "who is the advisor"
-- and for advisor data access).
-- -----------------------------------------------------------------------------
create table public.client_advisor_assignments (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null references public.clients (id),
  advisor_id       uuid not null references public.profiles (id),
  assignment_role  text not null default 'PRIMARY'
                   check (assignment_role in ('PRIMARY', 'SECONDARY', 'OPERATIONS')),
  is_active        boolean not null default true,
  assigned_at      timestamptz not null default now(),
  unassigned_at    timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references public.profiles (id),
  check (is_active or unassigned_at is not null)
);

create index caa_client_idx on public.client_advisor_assignments (client_id) where is_active;
create index caa_advisor_idx on public.client_advisor_assignments (advisor_id) where is_active;
create unique index caa_one_active_per_pair
  on public.client_advisor_assignments (client_id, advisor_id) where is_active;
create unique index caa_one_primary_per_client
  on public.client_advisor_assignments (client_id)
  where is_active and assignment_role = 'PRIMARY';

create trigger caa_touch_updated_at
  before update on public.client_advisor_assignments
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Client access helpers used by every RLS policy.
--
--   ADMIN       -> every client
--   OPERATIONS  -> every client (operations desk). To restrict operations to
--                  assigned clients only, change the OPERATIONS branch below.
--   ADVISOR     -> clients with an active assignment (or clients they created,
--                  so a freshly created client is visible before assignment).
-- -----------------------------------------------------------------------------
create or replace function app.can_access_client(p_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case app.user_role()
    when 'ADMIN' then true
    when 'OPERATIONS' then true
    when 'ADVISOR' then exists (
      select 1 from public.client_advisor_assignments a
      where a.client_id = p_client_id and a.advisor_id = auth.uid() and a.is_active
    ) or exists (
      select 1 from public.clients c
      where c.id = p_client_id and c.created_by = auth.uid()
    )
    else false
  end
$$;

-- Advisory authority: create plans, issue / revise / cancel calls.
create or replace function app.can_advise_client(p_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case app.user_role()
    when 'ADMIN' then true
    when 'ADVISOR' then app.can_access_client(p_client_id)
    else false
  end
$$;

-- Operational authority: record executions, upload CAS, run reconciliation.
create or replace function app.can_operate_client(p_client_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select app.can_access_client(p_client_id)
$$;

-- -----------------------------------------------------------------------------
-- Security master (mutual fund schemes / securities)
-- -----------------------------------------------------------------------------
create table public.security_master (
  id            uuid primary key default gen_random_uuid(),
  isin          text unique check (isin is null or isin ~ '^[A-Z]{2}[A-Z0-9]{9}[0-9]$'),
  amfi_code     text,
  scheme_name   text not null check (length(trim(scheme_name)) > 0),
  -- Normalised name for exact de-duplication of ISIN-less entries.
  name_key      text generated always as (
                  trim(regexp_replace(lower(scheme_name), '[^a-z0-9]+', ' ', 'g'))
                ) stored,
  amc           text,
  category      text,
  asset_class   text check (asset_class in ('EQUITY', 'DEBT', 'HYBRID', 'COMMODITY', 'CASH', 'OTHER')),
  plan_type     text check (plan_type in ('DIRECT', 'REGULAR')),
  option_type   text check (option_type in ('GROWTH', 'IDCW', 'OTHER')),
  aliases       text[] not null default '{}',
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references public.profiles (id)
);

create unique index security_master_name_key_no_isin
  on public.security_master (name_key) where isin is null;
create index security_master_amc_idx on public.security_master (amc);

create trigger security_master_touch_updated_at
  before update on public.security_master
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Documents (every uploaded file: CAS, advisory report, execution proof, ...)
-- Files live in the PRIVATE storage bucket `client-documents`, path
-- `<client_id>/<document_type>/<sha256>-<file name>`.
-- -----------------------------------------------------------------------------
create table public.documents (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references public.clients (id),
  document_type   text not null check (document_type in (
                    'CAS', 'ADVISORY_REPORT', 'EXECUTION_PROOF', 'KYC', 'OTHER')),
  file_path       text not null,
  file_name       text not null,
  mime_type       text,
  size_bytes      bigint check (size_bytes is null or size_bytes >= 0),
  sha256          text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  parse_status    text not null default 'NOT_APPLICABLE' check (parse_status in (
                    'NOT_APPLICABLE', 'UPLOADED', 'PROCESSING', 'PARSED', 'NEEDS_REVIEW', 'FAILED')),
  parse_error     text,
  description     text,
  deleted_at      timestamptz,
  deleted_by      uuid references public.profiles (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references public.profiles (id)
);

-- De-duplication: the same file cannot be uploaded twice for the same client
-- and document type (unless the earlier copy was soft-deleted).
create unique index documents_dedupe
  on public.documents (client_id, document_type, sha256) where deleted_at is null;
create index documents_client_idx on public.documents (client_id, created_at desc);
create index documents_status_idx on public.documents (parse_status);

create trigger documents_touch_updated_at
  before update on public.documents
  for each row execute function app.touch_updated_at();
