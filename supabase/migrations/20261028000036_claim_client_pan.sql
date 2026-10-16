-- =============================================================================
-- A client onboarded from the advisory report alone (a new mutual-fund
-- investor) has no PAN: their first CAS gives it. Whoever uploads that CAS
-- (Operations too, who may not edit clients) records it through this
-- function, and only this: on a client they can see, that has no PAN yet,
-- with a well-formed PAN no other client holds.
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
  if not app.can_access_client(p_client_id) then
    raise exception 'Client not found or you do not have access' using errcode = '42501';
  end if;
  if exists (select 1 from public.clients c where c.pan = v_pan and c.deleted_at is null and c.id <> p_client_id) then
    raise exception 'Another client already has this PAN' using errcode = '23505';
  end if;
  update public.clients set pan = v_pan where id = p_client_id and pan is null and deleted_at is null;
  return found;
end
$$;

comment on function public.claim_client_pan(uuid, text) is
  'Record the PAN read from the first CAS on a client onboarded without one (new investor from the report alone).';

revoke all on function public.claim_client_pan(uuid, text) from public;
grant execute on function public.claim_client_pan(uuid, text) to authenticated;
