-- =============================================================================
-- Univest MF Premium · Advisory Desk — 0012 Daily NAVs, live value, money left
--
-- 1. mf_schemes: every mutual-fund scheme published by AMFI (one row per ISIN)
--    with its latest NAV. Filled daily by the NAV feed (n8n -> /api/integrations
--    /nav-update). Reference data: no audit trail, written only by the server.
-- 2. nav_feed_runs: one row per feed delivery, so the desk can see how fresh
--    the NAVs are.
-- 3. v_holding_live / v_client_live_value: units from the latest CONFIRMED CAS
--    valued at the latest NAV (the CAS NAV is used until a newer NAV exists).
--    The onboarding snapshot keeps its own CAS NAVs and values for ever.
-- 4. v_client_cash: money freed by executed sells minus money spent on
--    executed buys (switches move money fund-to-fund and are excluded).
-- 5. v_client_summary gains live value + money-left columns (appended).
-- =============================================================================

create table public.mf_schemes (
  isin         text primary key check (isin ~ '^[A-Z]{2}[A-Z0-9]{9}[0-9]$'),
  amfi_code    text not null,
  scheme_name  text not null check (length(trim(scheme_name)) > 0),
  amc          text,
  category     text,
  plan_type    text check (plan_type in ('DIRECT', 'REGULAR')),
  option_type  text check (option_type in ('GROWTH', 'IDCW', 'OTHER')),
  nav          numeric(18,6) check (nav is null or nav > 0),
  nav_date     date,
  updated_at   timestamptz not null default now()
);

create index mf_schemes_amfi_code_idx on public.mf_schemes (amfi_code);
create index mf_schemes_name_idx on public.mf_schemes (lower(scheme_name));

create table public.nav_feed_runs (
  id              uuid primary key default gen_random_uuid(),
  received_at     timestamptz not null default now(),
  source          text not null,
  nav_date        date,
  schemes         integer not null default 0,
  new_schemes     integer not null default 0,
  navs_updated    integer not null default 0,
  holdings_priced integer not null default 0,
  holdings_unpriced integer not null default 0,
  notes           text
);

create index nav_feed_runs_received_idx on public.nav_feed_runs (received_at desc);

alter table public.mf_schemes enable row level security;
alter table public.nav_feed_runs enable row level security;
create policy mf_schemes_select on public.mf_schemes
  for select to authenticated using ((select app.is_staff()));
create policy nav_feed_runs_select on public.nav_feed_runs
  for select to authenticated using ((select app.is_staff()));
grant select on public.mf_schemes, public.nav_feed_runs to authenticated;
grant all on public.mf_schemes, public.nav_feed_runs to service_role;

-- -----------------------------------------------------------------------------
-- Holdings of the latest confirmed CAS, valued at the latest NAV.
-- -----------------------------------------------------------------------------
create or replace view public.v_holding_live
with (security_invoker = true) as
select
  h.id as holding_id,
  h.client_id,
  h.snapshot_id,
  h.security_id,
  h.scheme_name,
  h.folio_number,
  coalesce(h.isin, sm.isin) as isin,
  h.plan_type,
  h.units,
  h.latest_nav as cas_nav,
  h.latest_nav_date as cas_nav_date,
  h.current_value as cas_value,
  h.cost_value,
  m.nav as feed_nav,
  m.nav_date as feed_nav_date,
  -- A feed NAV older than the CAS NAV is never used.
  (m.nav is not null and (h.latest_nav_date is null or m.nav_date >= h.latest_nav_date)) as is_live,
  case when m.nav is not null and (h.latest_nav_date is null or m.nav_date >= h.latest_nav_date)
       then m.nav else h.latest_nav end::numeric(18,6) as nav,
  case when m.nav is not null and (h.latest_nav_date is null or m.nav_date >= h.latest_nav_date)
       then m.nav_date else h.latest_nav_date end as nav_date,
  case when m.nav is not null and (h.latest_nav_date is null or m.nav_date >= h.latest_nav_date)
       then round(h.units * m.nav, 2) else h.current_value end::numeric(18,2) as live_value
from public.v_latest_snapshot ls
join public.portfolio_holdings h on h.snapshot_id = ls.snapshot_id
left join public.security_master sm on sm.id = h.security_id
left join public.mf_schemes m on m.isin = coalesce(h.isin, sm.isin);

create or replace view public.v_client_live_value
with (security_invoker = true) as
select
  client_id,
  snapshot_id,
  sum(live_value)::numeric(18,2) as live_value,
  sum(cas_value)::numeric(18,2) as cas_value,
  max(nav_date) as nav_date,
  count(*) filter (where not is_live) as holdings_at_cas_nav
from public.v_holding_live
group by client_id, snapshot_id;

-- -----------------------------------------------------------------------------
-- Money left with the client after the calls they executed.
-- -----------------------------------------------------------------------------
create or replace view public.v_client_cash
with (security_invoker = true) as
select
  e.client_id,
  coalesce(sum(e.executed_amount) filter (where ai.action = 'SELL'), 0)::numeric(18,2) as sell_proceeds,
  coalesce(sum(e.executed_amount) filter (where ai.action = 'BUY'), 0)::numeric(18,2) as buy_spent,
  (coalesce(sum(e.executed_amount) filter (where ai.action = 'SELL'), 0)
   - coalesce(sum(e.executed_amount) filter (where ai.action = 'BUY'), 0))::numeric(18,2) as money_left,
  max(e.execution_date) as last_execution_date
from public.executions e
join public.advice_items ai on ai.id = e.advice_item_id
where e.status in ('EXECUTED', 'PARTIAL')
group by e.client_id;

-- -----------------------------------------------------------------------------
-- Client summary: same columns as 0008, plus live value and money left.
-- -----------------------------------------------------------------------------
create or replace view public.v_client_summary
with (security_invoker = true) as
select
  c.id as client_id,
  c.client_code,
  c.full_name,
  c.email,
  c.phone,
  c.pan,
  c.onboarding_date,
  c.risk_profile,
  c.goal,
  c.status,
  c.next_review_date,
  c.created_at,
  adv.advisor_id,
  adv.advisor_name,
  ls.snapshot_id as latest_snapshot_id,
  ls.snapshot_date as latest_cas_date,
  ls.total_current_value as current_portfolio_value,
  bs.total_current_value as initial_portfolio_value,
  bs.snapshot_date as baseline_date,
  ap.id as active_plan_id,
  ap.plan_name as active_plan_name,
  coalesce(t.sell_target, 0) as target_sell,
  coalesce(t.sell_advised, 0) as advised_sell,
  coalesce(t.sell_executed, 0) as executed_sell,
  coalesce(t.sell_pending, 0) as pending_sell,
  coalesce(t.sell_yet_to_advise, 0) as yet_to_advise_sell,
  coalesce(t.buy_target, 0) as target_buy,
  coalesce(t.buy_advised, 0) as advised_buy,
  coalesce(t.buy_executed, 0) as executed_buy,
  coalesce(t.buy_pending, 0) as pending_buy,
  coalesce(t.buy_yet_to_advise, 0) as yet_to_advise_buy,
  coalesce(open_adv.open_calls, 0) as open_calls,
  coalesce(open_adv.pending_total, 0)::numeric(18,2) as pending_total,
  coalesce(open_adv.off_plan_pending, 0)::numeric(18,2) as off_plan_pending,
  coalesce(att.unadvised_count, 0) as unadvised_count,
  coalesce(lv.live_value, ls.total_current_value) as live_portfolio_value,
  lv.nav_date as live_nav_date,
  coalesce(cash.sell_proceeds, 0)::numeric(18,2) as sell_proceeds,
  coalesce(cash.buy_spent, 0)::numeric(18,2) as buy_spent,
  coalesce(cash.money_left, 0)::numeric(18,2) as money_left
from public.clients c
left join lateral (
  select a.advisor_id, pr.full_name as advisor_name
  from public.client_advisor_assignments a
  join public.profiles pr on pr.id = a.advisor_id
  where a.client_id = c.id and a.is_active and a.assignment_role = 'PRIMARY'
  limit 1
) adv on true
left join public.v_latest_snapshot ls on ls.client_id = c.id
left join public.portfolio_snapshots bs on bs.client_id = c.id and bs.is_baseline
left join public.advisory_plans ap on ap.client_id = c.id and ap.status = 'ACTIVE'
left join public.v_plan_transition t on t.plan_id = ap.id
left join lateral (
  select
    count(*) filter (where v.is_open) as open_calls,
    sum(v.pending_amount) as pending_total,
    sum(v.pending_amount) filter (where v.plan_item_id is null) as off_plan_pending
  from public.v_advice_items v
  where v.client_id = c.id
) open_adv on true
left join lateral (
  select count(*) as unadvised_count
  from public.reconciliation_matches m
  where m.client_id = c.id and m.status = 'UNEXPLAINED'
    and m.classification = 'UNADVISED' and m.reviewed_at is null
) att on true
left join public.v_client_live_value lv on lv.client_id = c.id
left join public.v_client_cash cash on cash.client_id = c.id
where c.deleted_at is null;

grant select on public.v_holding_live, public.v_client_live_value, public.v_client_cash to authenticated;
grant select on public.v_client_summary to authenticated;
