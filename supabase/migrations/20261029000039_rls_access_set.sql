-- =============================================================================
-- Speed: check client access once per query, not once per row.
--
-- Every read policy said `app.can_access_client(client_id)`: a SECURITY DEFINER
-- function (so never inlined) that looks the user up and queries clients and
-- client_advisor_assignments, run for EVERY row read. The views behind the
-- Clients list, the home screen and the SIP tab read thousands of transaction,
-- holding and plan rows, so a page spent 1-4 s in those checks.
--
-- app.accessible_client_ids() returns the same set (same rule as
-- can_access_client: live clients; admins and operations see all of them, an
-- advisor the clients assigned to them or created by them) as one array.
-- Written as `client_id = any ((select app.accessible_client_ids())::uuid[])`, Postgres
-- evaluates it once per query (an InitPlan) and compares ids in memory.
--
-- Same rule, same result; only the read (and note-update) policies change.
-- Write policies (can_operate_client / can_advise_client) run per written row
-- and stay as they are.
-- =============================================================================

create or replace function app.accessible_client_ids()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(c.id), '{}'::uuid[])
  from public.clients c
  where c.deleted_at is null
    and case app.user_role()
          when 'ADMIN' then true
          when 'OPERATIONS' then true
          when 'ADVISOR' then exists (
            select 1 from public.client_advisor_assignments a
            where a.client_id = c.id and a.advisor_id = auth.uid() and a.is_active
          ) or c.created_by = auth.uid()
          else false
        end
$$;

comment on function app.accessible_client_ids() is
  'The clients the current user may read (same rule as app.can_access_client), as one array for set-based RLS checks.';

revoke all on function app.accessible_client_ids() from public, anon;
grant execute on function app.accessible_client_ids() to authenticated;

do $$
declare
  p record;
  q text;
  c text;
begin
  for p in
    select schemaname, tablename, policyname, qual, with_check
    from pg_policies
    where schemaname = 'public'
      and (qual like '%app.can_access_client(%' or with_check like '%app.can_access_client(%')
  loop
    q := replace(replace(p.qual,
           'app.can_access_client(client_id)', '(client_id = ANY ((SELECT app.accessible_client_ids())::uuid[]))'),
           'app.can_access_client(id)', '(id = ANY ((SELECT app.accessible_client_ids())::uuid[]))');
    c := replace(replace(p.with_check,
           'app.can_access_client(client_id)', '(client_id = ANY ((SELECT app.accessible_client_ids())::uuid[]))'),
           'app.can_access_client(id)', '(id = ANY ((SELECT app.accessible_client_ids())::uuid[]))');
    if q is not null and q like '%app.can_access_client(%' or c is not null and c like '%app.can_access_client(%' then
      raise exception 'Policy %.% uses can_access_client in a form this migration does not rewrite', p.tablename, p.policyname;
    end if;
    if q is not null then
      execute format('alter policy %I on %I.%I using (%s)', p.policyname, p.schemaname, p.tablename, q);
    end if;
    if c is not null then
      execute format('alter policy %I on %I.%I with check (%s)', p.policyname, p.schemaname, p.tablename, c);
    end if;
  end loop;
end
$$;

-- "FOR ALL" write policies also apply to SELECT, where Postgres ORs them with the read
-- policy and runs the write check (can_operate_client / can_advise_client) for every row
-- read. Split them into insert / update / delete policies with the same rules. The old
-- policies are retired in place (USING / WITH CHECK false adds nothing to an OR and costs
-- nothing) rather than dropped: the hosted migration tool will not run DROP statements.
alter policy portfolio_holdings_write on public.portfolio_holdings rename to portfolio_holdings_write_retired;
alter policy portfolio_holdings_write_retired on public.portfolio_holdings using (false) with check (false);
create policy portfolio_holdings_insert on public.portfolio_holdings
  for insert to authenticated with check (app.can_operate_client(client_id));
create policy portfolio_holdings_update on public.portfolio_holdings
  for update to authenticated using (app.can_operate_client(client_id)) with check (app.can_operate_client(client_id));
create policy portfolio_holdings_delete on public.portfolio_holdings
  for delete to authenticated using (app.can_operate_client(client_id));

alter policy advisory_plan_items_write on public.advisory_plan_items rename to advisory_plan_items_write_retired;
alter policy advisory_plan_items_write_retired on public.advisory_plan_items using (false) with check (false);
create policy advisory_plan_items_insert on public.advisory_plan_items
  for insert to authenticated with check (app.can_advise_client((select p.client_id from public.advisory_plans p where p.id = advisory_plan_items.plan_id)));
create policy advisory_plan_items_update on public.advisory_plan_items
  for update to authenticated using (app.can_advise_client(client_id))
  with check (app.can_advise_client((select p.client_id from public.advisory_plans p where p.id = advisory_plan_items.plan_id)));
create policy advisory_plan_items_delete on public.advisory_plan_items
  for delete to authenticated using (app.can_advise_client(client_id));
