-- =============================================================================
-- Plain PostgreSQL (Cloud SQL) setup for what Supabase used to provide.
--
-- The migrations and the app rely on four things that exist on every Supabase project and
-- NOT on plain Postgres:
--   1. the roles  authenticated  and  service_role  (and anon, only for grants that name it)
--   2. the schema auth: auth.users, auth.identities and the function auth.uid()
--      (row-level security reads the signed-in user from auth.uid())
--   3. a stub of the storage schema (storage.buckets / storage.objects), so migration 0010
--      compiles. Files are NOT stored in Postgres; this is only a stand-in.
--   4. the app's login user must be allowed to SET ROLE to authenticated (withUserTx does it
--      inside every transaction) and must own, or be granted, every table.
--
-- Idempotent: safe to run again. Run it as an admin (cloudsqlsuperuser / "postgres").
--   * Fresh test database:  run this file, then `npm run db:migrate`.
--   * Database already migrated: run it too; it only adds what is missing. Then run
--     `npm run db:check` (read-only) to see what is still missing.
-- Set the app's login user in the next block (the only line you may need to edit).
-- =============================================================================

do $$
declare
  app_user text := 'mf_app_user';   -- EDIT if the app connects as another user
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  -- The app never switches to service_role (server work runs as the app user), so it does not
  -- need BYPASSRLS, which Cloud SQL does not hand out. It exists because grants name it.
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit;
  end if;

  if exists (select 1 from pg_roles where rolname = app_user) then
    execute format('grant authenticated, service_role to %I', app_user);
    execute format('grant usage, create on schema public to %I', app_user);
  else
    raise notice 'Role % does not exist yet: create it, then run this file again.', app_user;
  end if;
end $$;

create extension if not exists pgcrypto;

-- ---- auth -----------------------------------------------------------------
create schema if not exists auth;
grant usage on schema auth to authenticated, service_role;

create table if not exists auth.users (
  instance_id                 uuid,
  id                          uuid primary key,
  aud                         varchar(255),
  role                        varchar(255),
  email                       varchar(255),
  encrypted_password          varchar(255),
  email_confirmed_at          timestamptz,
  invited_at                  timestamptz,
  confirmation_token          varchar(255),
  confirmation_sent_at        timestamptz,
  recovery_token              varchar(255),
  recovery_sent_at            timestamptz,
  email_change_token_new      varchar(255),
  email_change                varchar(255),
  email_change_sent_at        timestamptz,
  last_sign_in_at             timestamptz,
  raw_app_meta_data           jsonb,
  raw_user_meta_data          jsonb,
  is_super_admin              boolean,
  created_at                  timestamptz,
  updated_at                  timestamptz,
  phone                       text default null,
  phone_confirmed_at          timestamptz,
  phone_change                text default '',
  phone_change_token          varchar(255) default '',
  phone_change_sent_at        timestamptz,
  confirmed_at                timestamptz generated always as (least(email_confirmed_at, phone_confirmed_at)) stored,
  email_change_token_current  varchar(255) default '',
  email_change_confirm_status smallint default 0,
  banned_until                timestamptz,
  reauthentication_token      varchar(255) default '',
  reauthentication_sent_at    timestamptz,
  is_sso_user                 boolean not null default false,
  deleted_at                  timestamptz,
  is_anonymous                boolean not null default false
);
-- Same name and rule as Supabase's own index, so a migrated database already has it (no-op).
create unique index if not exists users_email_partial_key on auth.users (email) where is_sso_user = false;

create table if not exists auth.identities (
  provider_id     text not null,
  user_id         uuid not null references auth.users (id) on delete cascade,
  identity_data   jsonb not null,
  provider        text not null,
  last_sign_in_at timestamptz,
  created_at      timestamptz,
  updated_at      timestamptz,
  email           text generated always as (lower(identity_data ->> 'email')) stored,
  id              uuid primary key default gen_random_uuid(),
  unique (provider_id, provider)
);

-- The signed-in user, as the app sets it per transaction (request.jwt.claims). Same as Supabase's.
do $$
begin
  if to_regprocedure('auth.uid()') is null then
    create function auth.uid() returns uuid language sql stable as $f$
      select nullif(
        coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                 (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')), '')::uuid
    $f$;
  end if;
end $$;
grant execute on function auth.uid() to authenticated, service_role;

-- ---- storage stub (files live in object storage, not in Postgres) ---------------
create schema if not exists storage;
grant usage on schema storage to authenticated, service_role;

create table if not exists storage.buckets (
  id text primary key,
  name text not null unique,
  owner uuid,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid,
  metadata jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (bucket_id, name)
);
alter table storage.objects enable row level security;

-- ---- table access for the signed-in role ---------------------------------------
-- Same as a Supabase project's default: tables the migrations create are usable by
-- `authenticated` (row-level security and the migrations' own grants/revokes narrow that).
-- Objects created by the user running this file; if migrations run as another user, repeat
-- the next three lines as that user.
alter default privileges in schema public grant all on tables to authenticated, service_role;
alter default privileges in schema public grant all on sequences to authenticated, service_role;
alter default privileges in schema public grant execute on functions to authenticated, service_role;
grant usage on schema public to authenticated, service_role;
