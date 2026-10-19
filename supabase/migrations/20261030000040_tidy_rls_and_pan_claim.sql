-- =============================================================================
-- Tidy-up after 20261029000039 (flagged by the Supabase advisors).
--
-- 1. The two retired FOR ALL policies (USING / WITH CHECK false) still apply to
--    `authenticated`, so every check on those tables evaluates one extra
--    policy. They now apply to service_role only, which bypasses RLS anyway:
--    inert for everyone. (Retired in place, not dropped: the hosted migration
--    tool will not run DROP statements.)
-- 2. claim_client_pan lived in `public`, so it was also callable over the REST
--    API (/rest/v1/rpc/claim_client_pan). The app only calls it from SQL, so it
--    moves to the private `app` schema. Grants and checks stay as they are.
-- =============================================================================

alter policy portfolio_holdings_write_retired on public.portfolio_holdings to service_role;
alter policy advisory_plan_items_write_retired on public.advisory_plan_items to service_role;

alter function public.claim_client_pan(uuid, text) set schema app;

-- 3. Onboarding an investor whose PAN belongs to a client of another advisor: RLS hides that
--    client, so the identify step said "new" and saving failed on the unique index with a vague
--    message. This answers only yes / no (no name, no id) so the app can say so up front.
create or replace function app.pan_in_use(p_pan text, p_except uuid default null)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.clients c
    where c.pan = upper(trim(p_pan)) and c.deleted_at is null and c.id is distinct from p_except)
$$;

comment on function app.pan_in_use(text, uuid) is
  'True when a live client (other than p_except) holds this PAN, whoever the user can see. Yes / no only.';

revoke all on function app.pan_in_use(text, uuid) from public, anon;
grant execute on function app.pan_in_use(text, uuid) to authenticated;
