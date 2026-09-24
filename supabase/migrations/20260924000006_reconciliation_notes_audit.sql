-- =============================================================================
-- MN Advisory Dashboard — 0006 Reconciliation, client notes, audit log
-- =============================================================================

create table public.reconciliation_runs (
  id                     uuid primary key default gen_random_uuid(),
  client_id              uuid not null references public.clients (id),
  previous_snapshot_id   uuid not null references public.portfolio_snapshots (id),
  current_snapshot_id    uuid not null references public.portfolio_snapshots (id),
  status                 text not null default 'OPEN' check (status in ('OPEN', 'COMPLETED', 'CANCELLED')),
  previous_value         numeric(18,2) not null,
  current_value          numeric(18,2) not null,
  summary                jsonb not null default '{}'::jsonb,
  engine_version         text not null default 'v1',
  completed_at           timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  created_by             uuid references public.profiles (id),
  check (previous_snapshot_id <> current_snapshot_id)
);

create index reconciliation_runs_client_idx on public.reconciliation_runs (client_id, created_at desc);
create index reconciliation_runs_status_idx on public.reconciliation_runs (status);
-- A snapshot pair is reconciled once (re-running cancels the earlier run first).
create unique index reconciliation_runs_pair_unique
  on public.reconciliation_runs (previous_snapshot_id, current_snapshot_id) where status <> 'CANCELLED';

create trigger reconciliation_runs_touch_updated_at
  before update on public.reconciliation_runs
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- One row per (detected change x candidate advice item), or one row with no
-- advice item for unexplained / SIP-explained changes.
-- RULE 6: nothing is auto-confirmed. CAS_VERIFIED executions are only created
-- when a person confirms a match.
-- -----------------------------------------------------------------------------
create table public.reconciliation_matches (
  id                  uuid primary key default gen_random_uuid(),
  run_id              uuid not null references public.reconciliation_runs (id),
  client_id           uuid not null references public.clients (id),
  advice_item_id      uuid references public.advice_items (id),
  security_id         uuid references public.security_master (id),
  scheme_name         text not null,
  folio_numbers       text[] not null default '{}',
  change_type         text not null check (change_type in ('INCREASE', 'DECREASE', 'NEW_HOLDING', 'EXITED')),
  classification      text not null check (classification in ('ADVICE_MATCH', 'SIP_INSTALMENT', 'UNADVISED')),
  previous_units      numeric(20,4) not null default 0,
  current_units       numeric(20,4) not null default 0,
  detected_change     numeric(20,4) not null,       -- units, signed (negative = reduction)
  previous_value      numeric(18,2) not null default 0,
  current_value       numeric(18,2) not null default 0,
  approx_amount       numeric(18,2) not null default 0, -- |detected_change| x NAV, rupees
  reference_nav       numeric(18,4),
  expected_change     numeric(20,4),                -- units expected from the advice, signed
  expected_amount     numeric(18,2),                -- rupees expected from the advice
  allocated_units     numeric(20,4),                -- part of the detected change allocated to this advice
  confidence          text not null default 'NONE' check (confidence in ('HIGH', 'MEDIUM', 'LOW', 'NONE')),
  status              text not null default 'SUGGESTED' check (status in (
                        'SUGGESTED', 'CONFIRMED', 'REJECTED', 'PARTIAL', 'UNEXPLAINED')),
  system_note         text,
  confirmed_units     numeric(20,4),
  confirmed_amount    numeric(18,2),
  execution_id        uuid references public.executions (id),
  resolution_note     text,
  resolved_at         timestamptz,
  resolved_by         uuid references public.profiles (id),
  -- UNEXPLAINED rows need a human to look at them (Needs Attention).
  reviewed_at         timestamptz,
  reviewed_by         uuid references public.profiles (id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (classification <> 'ADVICE_MATCH' or advice_item_id is not null),
  check (status not in ('CONFIRMED', 'PARTIAL', 'REJECTED') or resolved_at is not null)
);

create index reconciliation_matches_run_idx on public.reconciliation_matches (run_id);
create index reconciliation_matches_client_idx on public.reconciliation_matches (client_id);
create index reconciliation_matches_advice_idx on public.reconciliation_matches (advice_item_id);
create index reconciliation_matches_security_idx on public.reconciliation_matches (security_id);
create index reconciliation_matches_status_idx on public.reconciliation_matches (status);

create trigger reconciliation_matches_touch_updated_at
  before update on public.reconciliation_matches
  for each row execute function app.touch_updated_at();

alter table public.executions
  add constraint executions_cas_match_fk
  foreign key (cas_verification_match_id) references public.reconciliation_matches (id);

-- -----------------------------------------------------------------------------
-- Client notes (follow-ups, call logs, reviews)
-- -----------------------------------------------------------------------------
create table public.client_notes (
  id                  uuid primary key default gen_random_uuid(),
  client_id           uuid not null references public.clients (id),
  note_type           text not null default 'GENERAL' check (note_type in (
                        'GENERAL', 'FOLLOW_UP', 'CALL_LOG', 'REVIEW', 'COMPLIANCE')),
  body                text not null check (length(trim(body)) > 0),
  advice_item_id      uuid references public.advice_items (id),
  follow_up_date      date,
  follow_up_done_at   timestamptz,
  deleted_at          timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid references public.profiles (id)
);

create index client_notes_client_idx on public.client_notes (client_id, created_at desc);
create index client_notes_follow_up_idx on public.client_notes (follow_up_date)
  where follow_up_date is not null and follow_up_done_at is null and deleted_at is null;

create trigger client_notes_touch_updated_at
  before update on public.client_notes
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Immutable audit trail. Written only by triggers (SECURITY DEFINER).
-- -----------------------------------------------------------------------------
create table public.audit_logs (
  id            bigint generated always as identity primary key,
  occurred_at   timestamptz not null default now(),
  actor_id      uuid,                 -- auth user; null for system/integration writes
  actor_label   text,                 -- e.g. 'integration:n8n', 'seed'
  client_id     uuid,
  entity_type   text not null,
  entity_id     uuid,
  action        text not null,        -- INSERT / UPDATE / DELETE
  changed_fields text[],
  old_value     jsonb,
  new_value     jsonb,
  reason        text
);

create index audit_logs_entity_idx on public.audit_logs (entity_type, entity_id, occurred_at desc);
create index audit_logs_client_idx on public.audit_logs (client_id, occurred_at desc);
create index audit_logs_actor_idx on public.audit_logs (actor_id, occurred_at desc);
create index audit_logs_occurred_idx on public.audit_logs (occurred_at desc);

create or replace function app.audit_logs_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_logs is append-only' using errcode = '42501';
end;
$$;

create trigger audit_logs_no_update
  before update or delete on public.audit_logs
  for each row execute function app.audit_logs_immutable();

create trigger audit_logs_no_truncate
  before truncate on public.audit_logs
  for each statement execute function app.audit_logs_immutable();
