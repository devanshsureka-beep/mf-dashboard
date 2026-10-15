-- Removing someone from the team: they can no longer sign in or see data, but
-- their profile stays (calls, plans and the audit log keep pointing at them).
alter table public.profiles
  add column if not exists removed_at timestamptz,
  add column if not exists removed_by uuid references auth.users (id);

alter table public.profiles drop constraint if exists profiles_removed_inactive;
alter table public.profiles
  add constraint profiles_removed_inactive check (removed_at is null or not is_active);

comment on column public.profiles.removed_at is 'Removed from the team by an admin (sign-in blocked); null = on the team. Adding them back clears it.';
