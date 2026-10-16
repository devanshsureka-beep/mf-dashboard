-- =============================================================================
-- claim_client_pan (20261028000036) for the onboarding paths that run as the
-- system (Operations' onboarding uses a system transaction, with no user JWT):
-- there auth.uid() is null and the access check would always refuse. A user
-- (a JWT) is still held to app.can_access_client; without one only the owner
-- or service_role can call it (execute is granted to authenticated only).
-- =============================================================================

create or replace function public.claim_client_pan(p_client_id uuid, p_pan text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pan text := upper(trim(coalesce(p_pan, '')));
begin
  if v_pan !~ '^[A-Z]{5}[0-9]{4}[A-Z]$' then
    raise exception 'Not a valid PAN' using errcode = '22023';
  end if;
  if auth.uid() is not null and not app.can_access_client(p_client_id) then
    raise exception 'Client not found or you do not have access' using errcode = '42501';
  end if;
  if exists (select 1 from public.clients c where c.pan = v_pan and c.deleted_at is null and c.id <> p_client_id) then
    raise exception 'Another client already has this PAN' using errcode = '23505';
  end if;
  update public.clients set pan = v_pan where id = p_client_id and pan is null and deleted_at is null;
  return found;
end
$$;

revoke all on function public.claim_client_pan(uuid, text) from public, anon;
grant execute on function public.claim_client_pan(uuid, text) to authenticated;
