-- =============================================================================
-- Deleting clients (admin). A client is never erased: financial history stays
-- for audit. Deleting sets deleted_at / deleted_by / deleted_reason, which
--   * hides the client and everything under it (CAS, plans, calls, executions,
--     documents, notes …) from every screen and every user, because
--     app.can_access_client() is false for a deleted client;
--   * frees the PAN, so the client can be onboarded again cleanly;
--   * can be undone by an admin (restore), who still sees deleted client rows.
-- =============================================================================

alter table public.clients
  add column if not exists deleted_by uuid references public.profiles (id),
  add column if not exists deleted_reason text;

create or replace function app.can_access_client(p_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when exists (select 1 from public.clients c where c.id = p_client_id and c.deleted_at is not null) then false
    else case app.user_role()
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
  end
$$;

-- Live clients as before; admins also see deleted client rows (to restore them;
-- a restored row must stay visible to the admin while it is being updated).
alter policy clients_select on public.clients
  using (
    (deleted_at is null
     and (app.can_access_client(id)
          -- the creator must see the row inside INSERT ... RETURNING, before the
          -- helper function can see it
          or (created_by = (select auth.uid()) and (select app.user_role()) in ('ADMIN', 'ADVISOR'))))
    or (select app.is_admin())
  );

-- Only an admin, with a reason, may delete or restore.
create or replace function app.guard_client_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.deleted_at is distinct from old.deleted_at then
    if not app.is_admin() and current_user not in ('postgres', 'service_role') then
      raise exception 'Only an admin can delete or restore a client' using errcode = '42501';
    end if;
    if app.audit_reason() is null then
      raise exception 'A reason is required to delete or restore a client' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create or replace trigger clients_guard_delete before update on public.clients
  for each row execute function app.guard_client_delete();

-- Private bucket for "Download everything (ZIP)" client exports. No storage
-- policies: only the server (service role) writes and signs them, after the
-- export itself was built under the user's RLS.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('client-exports', 'client-exports', false, 52428800, array['application/zip'])
on conflict (id) do nothing;
