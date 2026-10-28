-- =============================================================================
-- 0054 Client delete / restore guard: by "who is acting", not by database user name
--
-- Migration 0019 let the server through when current_user was 'postgres' or 'service_role'.
-- That name is Supabase's. On any other PostgreSQL (e.g. Cloud SQL) the app's own login user has
-- another name, so the server's work would be refused. The other guards already ask whether a
-- signed-in user is acting (auth.uid()); this one now does too. Behaviour is unchanged:
--   * a signed-in user who is not an admin is refused;
--   * an admin, or the server (no signed-in user), is allowed;
--   * a reason is still required.
-- =============================================================================

create or replace function app.guard_client_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.deleted_at is distinct from old.deleted_at then
    if auth.uid() is not null and not app.is_admin() then
      raise exception 'Only an admin can delete or restore a client' using errcode = '42501';
    end if;
    if app.audit_reason() is null then
      raise exception 'A reason is required to delete or restore a client' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
