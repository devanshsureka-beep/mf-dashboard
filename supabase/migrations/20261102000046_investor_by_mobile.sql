-- New investor without a PAN: the duplicate check (same mobile + same name) must see every
-- client, not only the advisor's own (RLS), or two advisors create the same person twice and
-- the first CAS then matches neither. Returns only clients with that mobile number.
create or replace function app.clients_with_mobile(p_mobile text)
returns table (id uuid, client_code text, full_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.client_code, c.full_name
  from public.clients c
  where c.deleted_at is null and length(p_mobile) = 10
    and right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10) = p_mobile
  order by c.created_at
$$;
revoke all on function app.clients_with_mobile(text) from public;
grant execute on function app.clients_with_mobile(text) to authenticated;
