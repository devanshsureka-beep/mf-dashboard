-- =============================================================================
-- MN Advisory Dashboard — 0004 Advisory plans, plan items, SIP plan items
--
-- RULE 1: Plan is not Advice. A plan is the END-STATE recommendation. Nothing
-- here means the client has been instructed; that lives in advice_batches /
-- advice_items.
-- =============================================================================

create table public.advisory_plans (
  id                        uuid primary key default gen_random_uuid(),
  client_id                 uuid not null references public.clients (id),
  plan_name                 text not null,
  plan_date                 date not null default app.today_ist(),
  status                    text not null default 'DRAFT' check (status in (
                              'DRAFT', 'ACTIVE', 'COMPLETED', 'REPLACED', 'CANCELLED')),
  baseline_snapshot_id      uuid references public.portfolio_snapshots (id),
  source_document_id        uuid references public.documents (id),
  extraction_source         text not null default 'MANUAL' check (extraction_source in (
                              'MANUAL', 'AI_EXTRACTION', 'IMPORT')),
  extraction_payload        jsonb,
  starting_portfolio_value  numeric(18,2),
  -- Current targets (kept equal to the sum of plan items by trigger).
  target_exit_value         numeric(18,2) not null default 0,
  target_buy_value          numeric(18,2) not null default 0,
  target_sip_value          numeric(18,2) not null default 0,
  -- Frozen copy of the targets at the moment of approval. Never changes.
  approved_target_exit_value numeric(18,2),
  approved_target_buy_value  numeric(18,2),
  approved_target_sip_value  numeric(18,2),
  notes                     text,
  approved_at               timestamptz,
  approved_by               uuid references public.profiles (id),
  locked_at                 timestamptz,
  closed_at                 timestamptz,
  replaced_by_plan_id       uuid references public.advisory_plans (id),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  created_by                uuid references public.profiles (id),
  check (status = 'DRAFT' or status = 'CANCELLED' or approved_at is not null)
);

create index advisory_plans_client_idx on public.advisory_plans (client_id, plan_date desc);
create index advisory_plans_status_idx on public.advisory_plans (status);
create index advisory_plans_created_at_idx on public.advisory_plans (created_at);
-- At most one ACTIVE plan per client.
create unique index advisory_plans_one_active on public.advisory_plans (client_id) where status = 'ACTIVE';

create trigger advisory_plans_touch_updated_at
  before update on public.advisory_plans
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Plan items. Lump-sum transition math uses:
--   SELL side = SELL + SWITCH (switch-out leg; the switch-in is a BUY item)
--   BUY side  = BUY
--   RETAIN    = no money movement
-- STOP_SIP / START_SIP exist for completeness, but SIP actions are tracked in
-- sip_plan_items and are excluded from lump-sum math.
-- -----------------------------------------------------------------------------
create table public.advisory_plan_items (
  id                 uuid primary key default gen_random_uuid(),
  plan_id            uuid not null references public.advisory_plans (id),
  client_id          uuid not null references public.clients (id),
  security_id        uuid references public.security_master (id),
  scheme_name        text not null,
  folio_number       text,
  action             text not null check (action in (
                       'SELL', 'BUY', 'RETAIN', 'SWITCH', 'STOP_SIP', 'START_SIP')),
  switch_to_security_id uuid references public.security_master (id),
  target_amount      numeric(18,2) not null default 0 check (target_amount >= 0),
  target_units       numeric(20,4) check (target_units is null or target_units >= 0),
  current_amount     numeric(18,2) check (current_amount is null or current_amount >= 0),
  target_weight      numeric(7,4) check (target_weight is null or (target_weight >= 0 and target_weight <= 100)),
  reason             text,
  priority           integer not null default 100,
  notes              text,
  status             text not null default 'OPEN' check (status in ('OPEN', 'COMPLETED', 'CANCELLED')),
  -- Extraction could not resolve the security with certainty.
  needs_review       boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid references public.profiles (id),
  check (action = 'RETAIN' or target_amount > 0 or target_units > 0)
);

create index advisory_plan_items_plan_idx on public.advisory_plan_items (plan_id, priority);
create index advisory_plan_items_client_idx on public.advisory_plan_items (client_id);
create index advisory_plan_items_security_idx on public.advisory_plan_items (security_id);
create index advisory_plan_items_status_idx on public.advisory_plan_items (status);

create trigger advisory_plan_items_touch_updated_at
  before update on public.advisory_plan_items
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- SIP plan (separate from lump-sum BUY/SELL)
-- -----------------------------------------------------------------------------
create table public.sip_plan_items (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null references public.clients (id),
  plan_id          uuid not null references public.advisory_plans (id),
  security_id      uuid references public.security_master (id),
  scheme_name      text not null,
  folio_number     text,
  action           text not null check (action in ('START', 'STOP', 'CHANGE')),
  old_amount       numeric(18,2) check (old_amount is null or old_amount >= 0),
  new_amount       numeric(18,2) check (new_amount is null or new_amount >= 0),
  frequency        text not null default 'MONTHLY' check (frequency in ('DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY')),
  -- Day of month the SIP debits (1-31). Null for daily/weekly SIPs.
  debit_day        smallint check (debit_day is null or debit_day between 1 and 31),
  status           text not null default 'PLANNED' check (status in ('PLANNED', 'ADVISED', 'COMPLETED', 'CANCELLED')),
  advised_at       timestamptz,
  completed_at     timestamptz,
  notes            text,
  needs_review     boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references public.profiles (id),
  check (action <> 'START' or new_amount > 0),
  check (action <> 'STOP' or old_amount > 0),
  check (action <> 'CHANGE' or (old_amount is not null and new_amount is not null)),
  check (status <> 'COMPLETED' or completed_at is not null)
);

create index sip_plan_items_client_idx on public.sip_plan_items (client_id);
create index sip_plan_items_plan_idx on public.sip_plan_items (plan_id);
create index sip_plan_items_status_idx on public.sip_plan_items (status);

create trigger sip_plan_items_touch_updated_at
  before update on public.sip_plan_items
  for each row execute function app.touch_updated_at();
