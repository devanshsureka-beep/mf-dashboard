-- =============================================================================
-- MN Advisory Dashboard — 0009 Row Level Security and grants
--
-- Access model (see app.can_access_client / can_advise_client):
--   ADMIN       full access, manages users and assignments, sees all audit logs
--   ADVISOR     assigned clients: plans, calls, executions, documents, notes
--   OPERATIONS  all clients: executions, CAS upload, reconciliation, notes,
--               SIP status updates; cannot create plans or issue/alter advice
--
-- anon has no access to anything. Deletes are blocked by triggers anyway, and
-- no DELETE privilege is granted except where drafts may be removed.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all functions in schema public from anon;
revoke all on all tables in schema public from authenticated;

grant select, update on public.profiles to authenticated;
grant select, insert, update on
  public.clients, public.client_advisor_assignments, public.security_master, public.documents,
  public.cas_documents, public.portfolio_snapshots, public.portfolio_transactions,
  public.advisory_plans, public.advice_batches, public.advice_items, public.executions,
  public.reconciliation_runs, public.reconciliation_matches, public.client_notes
  to authenticated;
grant select, insert, update, delete on
  public.portfolio_holdings, public.advisory_plan_items, public.sip_plan_items
  to authenticated;
grant select on public.audit_logs to authenticated;
grant usage on all sequences in schema public to authenticated;

grant select on
  public.v_advice_item_progress, public.v_advice_items, public.v_plan_item_progress,
  public.v_plan_transition, public.v_latest_snapshot, public.v_snapshot_change,
  public.v_client_summary, public.v_pending_executions, public.v_sip_summary
  to authenticated;
grant execute on function public.command_centre_metrics(date) to authenticated;

grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
revoke update, delete, truncate on public.audit_logs from service_role, authenticated;

-- -----------------------------------------------------------------------------
-- Enable RLS everywhere
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles', 'clients', 'client_advisor_assignments', 'security_master', 'documents',
    'cas_documents', 'portfolio_snapshots', 'portfolio_holdings', 'portfolio_transactions',
    'advisory_plans', 'advisory_plan_items', 'sip_plan_items',
    'advice_batches', 'advice_items', 'executions',
    'reconciliation_runs', 'reconciliation_matches', 'client_notes', 'audit_logs'
  ] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- profiles
-- -----------------------------------------------------------------------------
create policy profiles_select on public.profiles
  for select to authenticated using ((select app.is_staff()) or id = (select auth.uid()));
create policy profiles_update on public.profiles
  for update to authenticated
  using (id = (select auth.uid()) or (select app.is_admin()))
  with check (id = (select auth.uid()) or (select app.is_admin()));

-- -----------------------------------------------------------------------------
-- clients
-- -----------------------------------------------------------------------------
create policy clients_select on public.clients
  for select to authenticated
  using (
    (app.can_access_client(id)
     -- the creator must see the row inside INSERT ... RETURNING, before the
     -- helper function can see it
     or (created_by = (select auth.uid()) and (select app.user_role()) in ('ADMIN', 'ADVISOR')))
    and (deleted_at is null or (select app.is_admin()))
  );
create policy clients_insert on public.clients
  for insert to authenticated
  with check ((select app.user_role()) in ('ADMIN', 'ADVISOR') and created_by = (select auth.uid()));
create policy clients_update on public.clients
  for update to authenticated
  using (app.can_advise_client(id))
  with check (app.can_advise_client(id));

-- -----------------------------------------------------------------------------
-- client_advisor_assignments
-- -----------------------------------------------------------------------------
create policy caa_select on public.client_advisor_assignments
  for select to authenticated using (app.can_access_client(client_id));
create policy caa_insert on public.client_advisor_assignments
  for insert to authenticated
  with check (
    (select app.is_admin())
    or (
      (select app.user_role()) = 'ADVISOR'
      and advisor_id = (select auth.uid())
      and assignment_role = 'PRIMARY'
      and exists (select 1 from public.clients c where c.id = client_id and c.created_by = (select auth.uid()))
    )
  );
create policy caa_update on public.client_advisor_assignments
  for update to authenticated using ((select app.is_admin())) with check ((select app.is_admin()));

-- -----------------------------------------------------------------------------
-- security_master (shared reference data)
-- -----------------------------------------------------------------------------
create policy security_master_select on public.security_master
  for select to authenticated using ((select app.is_staff()));
create policy security_master_insert on public.security_master
  for insert to authenticated with check ((select app.is_staff()));
create policy security_master_update on public.security_master
  for update to authenticated using ((select app.is_staff())) with check ((select app.is_staff()));

-- -----------------------------------------------------------------------------
-- documents / CAS / snapshots / holdings / transactions
-- -----------------------------------------------------------------------------
create policy documents_select on public.documents
  for select to authenticated
  using (app.can_access_client(client_id) and (deleted_at is null or (select app.is_admin())));
create policy documents_insert on public.documents
  for insert to authenticated
  with check (app.can_operate_client(client_id) and created_by = (select auth.uid()));
create policy documents_update on public.documents
  for update to authenticated
  using (app.can_operate_client(client_id)) with check (app.can_operate_client(client_id));

create policy cas_documents_select on public.cas_documents
  for select to authenticated using (app.can_access_client(client_id));
create policy cas_documents_insert on public.cas_documents
  for insert to authenticated
  with check (app.can_operate_client(client_id) and created_by = (select auth.uid()));
create policy cas_documents_update on public.cas_documents
  for update to authenticated
  using (app.can_operate_client(client_id)) with check (app.can_operate_client(client_id));

create policy portfolio_snapshots_select on public.portfolio_snapshots
  for select to authenticated using (app.can_access_client(client_id));
create policy portfolio_snapshots_insert on public.portfolio_snapshots
  for insert to authenticated with check (app.can_operate_client(client_id));
create policy portfolio_snapshots_update on public.portfolio_snapshots
  for update to authenticated
  using (app.can_operate_client(client_id)) with check (app.can_operate_client(client_id));

create policy portfolio_holdings_select on public.portfolio_holdings
  for select to authenticated using (app.can_access_client(client_id));
create policy portfolio_holdings_write on public.portfolio_holdings
  for all to authenticated
  using (app.can_operate_client(client_id)) with check (app.can_operate_client(client_id));

create policy portfolio_transactions_select on public.portfolio_transactions
  for select to authenticated using (app.can_access_client(client_id));
create policy portfolio_transactions_insert on public.portfolio_transactions
  for insert to authenticated with check (app.can_operate_client(client_id));

-- -----------------------------------------------------------------------------
-- advisory plans (advisors / admins only write)
-- -----------------------------------------------------------------------------
create policy advisory_plans_select on public.advisory_plans
  for select to authenticated using (app.can_access_client(client_id));
create policy advisory_plans_insert on public.advisory_plans
  for insert to authenticated
  with check (app.can_advise_client(client_id) and created_by = (select auth.uid()));
create policy advisory_plans_update on public.advisory_plans
  for update to authenticated
  using (app.can_advise_client(client_id)) with check (app.can_advise_client(client_id));

create policy advisory_plan_items_select on public.advisory_plan_items
  for select to authenticated using (app.can_access_client(client_id));
create policy advisory_plan_items_write on public.advisory_plan_items
  for all to authenticated
  using (app.can_advise_client(client_id))
  with check (app.can_advise_client((select p.client_id from public.advisory_plans p where p.id = plan_id)));

create policy sip_plan_items_select on public.sip_plan_items
  for select to authenticated using (app.can_access_client(client_id));
create policy sip_plan_items_insert on public.sip_plan_items
  for insert to authenticated
  with check (app.can_advise_client((select p.client_id from public.advisory_plans p where p.id = plan_id)));
create policy sip_plan_items_delete on public.sip_plan_items
  for delete to authenticated using (app.can_advise_client(client_id));
-- Operations may progress SIP status (stopped / started); field restriction below.
create policy sip_plan_items_update on public.sip_plan_items
  for update to authenticated
  using (app.can_operate_client(client_id)) with check (app.can_operate_client(client_id));

create or replace function app.guard_sip_item_operations()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if app.user_role() = 'OPERATIONS' then
    perform app.assert_unchanged(to_jsonb(old), to_jsonb(new),
      array['security_id', 'scheme_name', 'folio_number', 'action', 'old_amount', 'new_amount',
            'frequency', 'debit_day', 'needs_review'],
      'sip_plan_items (operations may only update status and notes)');
  end if;
  return new;
end;
$$;

create trigger sip_plan_items_guard_operations
  before update on public.sip_plan_items
  for each row execute function app.guard_sip_item_operations();

-- -----------------------------------------------------------------------------
-- advice ledger
-- -----------------------------------------------------------------------------
create policy advice_batches_select on public.advice_batches
  for select to authenticated using (app.can_access_client(client_id));
create policy advice_batches_insert on public.advice_batches
  for insert to authenticated
  with check (
    app.can_advise_client(client_id)
    and created_by = (select auth.uid())
    and (advisor_id = (select auth.uid()) or (select app.is_admin()))
  );
create policy advice_batches_update on public.advice_batches
  for update to authenticated
  using (app.can_advise_client(client_id)) with check (app.can_advise_client(client_id));

create policy advice_items_select on public.advice_items
  for select to authenticated using (app.can_access_client(client_id));
create policy advice_items_insert on public.advice_items
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and app.can_advise_client((select b.client_id from public.advice_batches b where b.id = advice_batch_id))
  );
create policy advice_items_update on public.advice_items
  for update to authenticated
  using (app.can_advise_client(client_id)) with check (app.can_advise_client(client_id));

-- -----------------------------------------------------------------------------
-- executions (advisors and operations)
-- -----------------------------------------------------------------------------
create policy executions_select on public.executions
  for select to authenticated using (app.can_access_client(client_id));
create policy executions_insert on public.executions
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and app.can_operate_client((select a.client_id from public.advice_items a where a.id = advice_item_id))
  );
create policy executions_update on public.executions
  for update to authenticated
  using (app.can_operate_client(client_id)) with check (app.can_operate_client(client_id));

-- -----------------------------------------------------------------------------
-- reconciliation
-- -----------------------------------------------------------------------------
create policy reconciliation_runs_select on public.reconciliation_runs
  for select to authenticated using (app.can_access_client(client_id));
create policy reconciliation_runs_insert on public.reconciliation_runs
  for insert to authenticated
  with check (app.can_operate_client(client_id) and created_by = (select auth.uid()));
create policy reconciliation_runs_update on public.reconciliation_runs
  for update to authenticated
  using (app.can_operate_client(client_id)) with check (app.can_operate_client(client_id));

create policy reconciliation_matches_select on public.reconciliation_matches
  for select to authenticated using (app.can_access_client(client_id));
create policy reconciliation_matches_insert on public.reconciliation_matches
  for insert to authenticated with check (app.can_operate_client(client_id));
create policy reconciliation_matches_update on public.reconciliation_matches
  for update to authenticated
  using (app.can_operate_client(client_id)) with check (app.can_operate_client(client_id));

-- -----------------------------------------------------------------------------
-- notes
-- -----------------------------------------------------------------------------
create policy client_notes_select on public.client_notes
  for select to authenticated
  using (app.can_access_client(client_id) and (deleted_at is null or (select app.is_admin())));
create policy client_notes_insert on public.client_notes
  for insert to authenticated
  with check (app.can_operate_client(client_id) and created_by = (select auth.uid()));
create policy client_notes_update on public.client_notes
  for update to authenticated
  using (app.can_access_client(client_id) and (created_by = (select auth.uid()) or (select app.is_admin())))
  with check (app.can_access_client(client_id));

-- -----------------------------------------------------------------------------
-- audit_logs: read-only. Admins see everything; others see their clients' trail.
-- Rows are written exclusively by the SECURITY DEFINER audit trigger.
-- -----------------------------------------------------------------------------
create policy audit_logs_select on public.audit_logs
  for select to authenticated
  using ((select app.is_admin()) or (client_id is not null and app.can_access_client(client_id)));
