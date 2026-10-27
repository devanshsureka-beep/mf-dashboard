-- =============================================================================
-- 0053 Only an admin (or the server) changes a profile's sign-in fields
--
-- While AUTH_MODE=app is on, Supabase Auth stays enabled so switching back is a
-- config change. A user who signs in to Supabase Auth directly could then update
-- their own profile through the Data API. The guard already stopped them changing
-- role, activation or email; it now also covers the forced password change and
-- removal from the team. The server (withSystemTx, no auth.uid()) and admins are
-- not affected.
-- =============================================================================

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
       or new.id is distinct from old.id
       or new.must_change_password is distinct from old.must_change_password
       or new.removed_at is distinct from old.removed_at
       or new.removed_by is distinct from old.removed_by then
      raise exception 'Only an admin can change role, activation, email, removal or the password-change flag of a profile'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
