-- =============================================================================
-- 0026 Calls outside the plan: only those of the current plan.
--
-- v_client_rebalance_extra counted every call without a plan line in the
-- client's whole history, so calls given under a plan that was later replaced
-- showed as "not in plan" on the new one. Same columns as 0022 (the migrate_*
-- columns read 0 since 0023); the off-plan sums now take only calls whose
-- batch belongs to the client's ACTIVE plan. (Create or replace, not drop:
-- dropping this view hangs on Supabase, see 0023.)
-- =============================================================================

create or replace view public.v_client_rebalance_extra
with (security_invoker = true) as
with mig_lines as (
  select pi.client_id, pi.id, pi.target_amount
  from public.advisory_plan_items pi
  join public.advisory_plans p on p.id = pi.plan_id and p.status = 'ACTIVE'
  where pi.action = 'MIGRATE' and pi.status <> 'CANCELLED'
), mig_calls as (
  select v.plan_item_id,
         sum(v.effective_advised_amount) as advised, sum(v.executed_amount) as executed, sum(v.pending_amount) as pending
  from public.v_advice_items v
  where v.plan_item_id in (select id from mig_lines)
  group by v.plan_item_id
), mig as (
  select l.client_id,
         sum(l.target_amount) as target,
         sum(coalesce(c.advised, 0)) as advised,
         sum(coalesce(c.executed, 0)) as executed,
         sum(coalesce(c.pending, 0)) as pending,
         sum(greatest(l.target_amount - coalesce(c.advised, 0), 0)) as left_to_advise
  from mig_lines l left join mig_calls c on c.plan_item_id = l.id
  group by l.client_id
), mig_direct as (
  -- The Direct plans being migrated to: buying one is the second leg of the migration.
  select distinct pi.client_id, pi.switch_to_security_id as security_id
  from public.advisory_plan_items pi
  join public.advisory_plans p on p.id = pi.plan_id and p.status = 'ACTIVE'
  where pi.action = 'MIGRATE' and pi.status <> 'CANCELLED' and pi.switch_to_security_id is not null
), loose as (
  select v.*, (v.action = 'BUY' and d.security_id is not null) as is_mig_buy
  from public.v_advice_items v
  -- Only calls given under the client's current plan; earlier plans' calls belong to those plans.
  join public.advisory_plans ap on ap.id = v.batch_plan_id and ap.status = 'ACTIVE'
  left join mig_direct d on d.client_id = v.client_id and d.security_id = v.security_id
  where v.plan_item_id is null
), off as (
  select client_id,
         sum(effective_advised_amount) filter (where action <> 'BUY') as sell_advised,
         sum(executed_amount) filter (where action <> 'BUY') as sell_executed,
         sum(pending_amount) filter (where action <> 'BUY') as sell_pending,
         sum(effective_advised_amount) filter (where action = 'BUY' and not is_mig_buy) as buy_advised,
         sum(executed_amount) filter (where action = 'BUY' and not is_mig_buy) as buy_executed,
         sum(pending_amount) filter (where action = 'BUY' and not is_mig_buy) as buy_pending,
         sum(effective_advised_amount) filter (where is_mig_buy) as mig_buy_advised,
         sum(executed_amount) filter (where is_mig_buy) as mig_buy_executed,
         sum(pending_amount) filter (where is_mig_buy) as mig_buy_pending
  from loose
  group by client_id
)
select
  c.id as client_id,
  coalesce(mig.target, 0)::numeric(18,2) as migrate_target,
  coalesce(mig.advised, 0)::numeric(18,2) as migrate_advised,
  coalesce(mig.executed, 0)::numeric(18,2) as migrate_executed,
  coalesce(mig.pending, 0)::numeric(18,2) as migrate_pending,
  coalesce(mig.left_to_advise, 0)::numeric(18,2) as migrate_left,
  coalesce(off.mig_buy_advised, 0)::numeric(18,2) as migrate_buy_advised,
  coalesce(off.mig_buy_executed, 0)::numeric(18,2) as migrate_buy_executed,
  coalesce(off.mig_buy_pending, 0)::numeric(18,2) as migrate_buy_pending,
  coalesce(off.sell_advised, 0)::numeric(18,2) as off_plan_sell_advised,
  coalesce(off.sell_executed, 0)::numeric(18,2) as off_plan_sell_executed,
  coalesce(off.sell_pending, 0)::numeric(18,2) as off_plan_sell_pending,
  coalesce(off.buy_advised, 0)::numeric(18,2) as off_plan_buy_advised,
  coalesce(off.buy_executed, 0)::numeric(18,2) as off_plan_buy_executed,
  coalesce(off.buy_pending, 0)::numeric(18,2) as off_plan_buy_pending
from public.clients c
left join mig on mig.client_id = c.id
left join off on off.client_id = c.id
where c.deleted_at is null;

grant select on public.v_client_rebalance_extra to authenticated;
