-- =============================================================================
-- 0052 Sign-in handled by the app (AUTH_MODE=app)
--
-- Users stay in auth.users (same ids, same bcrypt hashes) and roles in
-- public.profiles, so switching back to Supabase Auth (AUTH_MODE=supabase) only
-- needs the config change. The app keeps its own sessions, login attempts and
-- one-time links here. These tables live in the `app` schema (not exposed by the
-- Supabase Data API), have RLS on with no policies and no grants: only the
-- server (withSystemTx, the table owner) reads or writes them.
--
-- Only hashes are stored (HMAC-SHA256 with SESSION_SECRET): a copy of the
-- database is not a set of working sessions or reset links.
-- =============================================================================

create table app.sessions (
  token_hash   text primary key,
  user_id      uuid not null references auth.users (id) on delete cascade,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  last_seen_at timestamptz not null default now(),
  ip           text,
  user_agent   text
);
create index sessions_user_idx on app.sessions (user_id);
create index sessions_expires_idx on app.sessions (expires_at);

-- Every sign-in attempt, for the per-account and per-IP limits (kept 30 days by the app).
create table app.login_attempts (
  id         bigint generated always as identity primary key,
  email      text not null,
  ip         text,
  ok         boolean not null,
  at         timestamptz not null default now()
);
create index login_attempts_email_idx on app.login_attempts (email, at desc);
create index login_attempts_ip_idx on app.login_attempts (ip, at desc);

-- One-time links: password reset and invite. Single use, short expiry.
create table app.auth_tokens (
  token_hash text primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  purpose    text not null check (purpose in ('RESET', 'INVITE')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz
);
create index auth_tokens_user_idx on app.auth_tokens (user_id);

alter table app.sessions enable row level security;
alter table app.login_attempts enable row level security;
alter table app.auth_tokens enable row level security;
revoke all on app.sessions, app.login_attempts, app.auth_tokens from public, anon, authenticated, service_role;

-- A temporary password set by an admin must be changed at the next sign-in.
alter table public.profiles add column if not exists must_change_password boolean not null default false;
