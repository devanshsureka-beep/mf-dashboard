-- =============================================================================
-- MN Advisory Dashboard — 0001 Foundation
--
-- Private helper schema, generic triggers and staff profiles.
--
-- Conventions used across all migrations:
--   * UUID primary keys (gen_random_uuid()).
--   * Status / type columns are TEXT + CHECK constraints (easier to evolve than
--     Postgres enums: add a value by editing one constraint).
--   * Money: numeric(18,2) rupees. Units: numeric(20,4). NAV/price: numeric(18,4).
--   * Financial history is never hard-deleted; soft delete via deleted_at or
--     terminal status values.
-- =============================================================================

-- gen_random_uuid() is built into PostgreSQL 13+; no extension required.

-- Private schema for helpers. Not exposed through the Supabase Data API.
create schema if not exists app;
revoke all on schema app from public;
grant usage on schema app to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Generic updated_at trigger
-- -----------------------------------------------------------------------------
create or replace function app.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Calendar "today" for an Indian advisory business. All "today" metrics use IST.
create or replace function app.today_ist()
returns date
language sql
stable
set search_path = ''
as $$
  select (now() at time zone 'Asia/Kolkata')::date
$$;

-- -----------------------------------------------------------------------------
-- Staff profiles (1:1 with auth.users)
-- -----------------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete restrict,
  full_name   text not null default '',
  email       text not null,
  phone       text,
  role        text not null default 'OPERATIONS'
              check (role in ('ADMIN', 'ADVISOR', 'OPERATIONS')),
  -- New auth users start inactive and get no data access until an admin
  -- activates them (defence in depth on top of disabled public sign-ups).
  is_active   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references auth.users (id)
);

comment on table public.profiles is
  'Staff users (ADMIN / ADVISOR / OPERATIONS). Client-portal users will get a separate table later.';

create index profiles_role_idx on public.profiles (role) where is_active;

create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function app.touch_updated_at();

-- Create a profile automatically for every new auth user.
-- Role / activation come ONLY from raw_app_meta_data, which can be written
-- solely with the service-role key (never by the user themselves).
create or replace function app.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text := upper(coalesce(new.raw_app_meta_data ->> 'mn_role', 'OPERATIONS'));
begin
  if v_role not in ('ADMIN', 'ADVISOR', 'OPERATIONS') then
    v_role := 'OPERATIONS';
  end if;

  insert into public.profiles (id, email, full_name, role, is_active)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_app_meta_data ->> 'mn_full_name', new.raw_user_meta_data ->> 'full_name', ''),
    v_role,
    coalesce((new.raw_app_meta_data ->> 'mn_active')::boolean, false)
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app.handle_new_auth_user();

-- -----------------------------------------------------------------------------
-- Role helpers (SECURITY DEFINER so they can read profiles regardless of RLS)
-- -----------------------------------------------------------------------------
create or replace function app.user_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.role
  from public.profiles p
  where p.id = auth.uid() and p.is_active
$$;

create or replace function app.is_admin()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(app.user_role() = 'ADMIN', false)
$$;

create or replace function app.is_staff()
returns boolean
language sql
stable
set search_path = ''
as $$
  select app.user_role() is not null
$$;

-- Prevent anyone except an admin (or a trusted server/service context) from
-- changing role / activation, including on their own profile.
create or replace function app.guard_profile_changes()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if auth.uid() is not null and not app.is_admin() then
    if new.role is distinct from old.role
       or new.is_active is distinct from old.is_active
       or new.email is distinct from old.email
       or new.id is distinct from old.id then
      raise exception 'Only an admin can change role, activation or email of a profile'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create trigger profiles_guard_changes
  before update on public.profiles
  for each row execute function app.guard_profile_changes();
