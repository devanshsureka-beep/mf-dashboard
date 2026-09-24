-- =============================================================================
-- MN Advisory Dashboard — 0005 Advice ledger and executions
--
-- RULE 2: Advice is not Execution.
-- An advice batch is one communication with the client (a call, a WhatsApp
-- message, ...). It carries one or more advice items (individual calls).
-- Executions record what the client actually did against an advice item;
-- many (partial) executions may exist per advice item.
-- =============================================================================

create sequence public.advice_batch_code_seq start with 1;

create table public.advice_batches (
  id                     uuid primary key default gen_random_uuid(),
  batch_code             text not null unique
                         default ('AB-' || lpad(nextval('public.advice_batch_code_seq')::text, 6, '0')),
  client_id              uuid not null references public.clients (id),
  advisor_id             uuid not null references public.profiles (id),
  plan_id                uuid references public.advisory_plans (id),
  -- Exact time the advice was communicated to the client. Immutable.
  communicated_at        timestamptz not null default now(),
  communication_channel  text not null check (communication_channel in (
                           'PHONE', 'WHATSAPP', 'EMAIL', 'IN_PERSON', 'OTHER')),
  notes                  text,
  status                 text not null default 'ACTIVE' check (status in ('ACTIVE', 'CANCELLED')),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  created_by             uuid references public.profiles (id),
  check (communicated_at <= created_at + interval '5 minutes')
);

create index advice_batches_client_idx on public.advice_batches (client_id, communicated_at desc);
create index advice_batches_advisor_idx on public.advice_batches (advisor_id, communicated_at desc);
create index advice_batches_communicated_idx on public.advice_batches (communicated_at desc);
create index advice_batches_plan_idx on public.advice_batches (plan_id);
create index advice_batches_created_at_idx on public.advice_batches (created_at);

create trigger advice_batches_touch_updated_at
  before update on public.advice_batches
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Advice items.
--
-- quantity_basis decides when a call counts as fully executed:
--   AMOUNT -> executed rupees reach advised_amount (within 1% tolerance)
--   UNITS  -> executed units reach advised_units
-- advised_amount is ALWAYS present (for unit calls it is the rupee estimate at
-- the reference price) so that rupee roll-ups stay meaningful.
--
-- Revisions never overwrite: the original item becomes REVISED and a new item
-- points back to it through revises_advice_item_id.
-- -----------------------------------------------------------------------------
create table public.advice_items (
  id                      uuid primary key default gen_random_uuid(),
  advice_batch_id         uuid not null references public.advice_batches (id),
  client_id               uuid not null references public.clients (id),
  plan_item_id            uuid references public.advisory_plan_items (id),
  security_id             uuid not null references public.security_master (id),
  scheme_name             text not null,
  folio_number            text,
  action                  text not null check (action in ('BUY', 'SELL', 'SWITCH')),
  quantity_basis          text not null default 'AMOUNT' check (quantity_basis in ('AMOUNT', 'UNITS')),
  advised_amount          numeric(18,2) not null check (advised_amount > 0),
  advised_units           numeric(20,4) check (advised_units is null or advised_units > 0),
  reference_price         numeric(18,4) check (reference_price is null or reference_price > 0),
  valid_until             date,
  status                  text not null default 'ISSUED' check (status in (
                            'ISSUED', 'PARTIALLY_EXECUTED', 'EXECUTED', 'CANCELLED', 'EXPIRED', 'REVISED')),
  revises_advice_item_id  uuid unique references public.advice_items (id),
  status_changed_at       timestamptz,
  status_reason           text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  created_by              uuid references public.profiles (id),
  check (quantity_basis = 'AMOUNT' or advised_units is not null)
);

create index advice_items_batch_idx on public.advice_items (advice_batch_id);
create index advice_items_client_idx on public.advice_items (client_id);
create index advice_items_plan_item_idx on public.advice_items (plan_item_id);
create index advice_items_security_idx on public.advice_items (security_id);
create index advice_items_status_idx on public.advice_items (status);
create index advice_items_open_idx on public.advice_items (client_id, security_id)
  where status in ('ISSUED', 'PARTIALLY_EXECUTED');
create index advice_items_created_at_idx on public.advice_items (created_at);

create trigger advice_items_touch_updated_at
  before update on public.advice_items
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Executions (what the client actually did). Always tied to an advice item;
-- activity with no advice is recorded as UNADVISED in reconciliation instead.
-- Only EXECUTED and PARTIAL rows count towards executed totals.
-- -----------------------------------------------------------------------------
create table public.executions (
  id                          uuid primary key default gen_random_uuid(),
  client_id                   uuid not null references public.clients (id),
  advice_item_id              uuid not null references public.advice_items (id),
  security_id                 uuid not null references public.security_master (id),
  execution_date              date not null,
  execution_time              time,
  executed_amount             numeric(18,2) not null check (executed_amount >= 0),
  executed_units              numeric(20,4) check (executed_units is null or executed_units >= 0),
  execution_price             numeric(18,4) check (execution_price is null or execution_price > 0),
  verification_type           text not null check (verification_type in (
                                'CLIENT_CONFIRMED', 'ADVISOR_CONFIRMED', 'PROOF_VERIFIED', 'CAS_VERIFIED')),
  status                      text not null default 'EXECUTED' check (status in (
                                'PENDING', 'PARTIAL', 'EXECUTED', 'REJECTED', 'CANCELLED')),
  notes                       text,
  proof_document_id           uuid references public.documents (id),
  -- Set when a later CAS independently confirms this execution.
  cas_verified_at             timestamptz,
  cas_verification_match_id   uuid,
  status_changed_at           timestamptz,
  status_reason               text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  created_by                  uuid references public.profiles (id),
  check (executed_amount > 0 or executed_units > 0)
);

create index executions_client_idx on public.executions (client_id, execution_date desc);
create index executions_advice_item_idx on public.executions (advice_item_id);
create index executions_security_idx on public.executions (security_id);
create index executions_status_idx on public.executions (status);
create index executions_created_at_idx on public.executions (created_at);

create trigger executions_touch_updated_at
  before update on public.executions
  for each row execute function app.touch_updated_at();
