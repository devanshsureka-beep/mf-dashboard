-- =============================================================================
-- 0047 Approved money: what a person approved as done counts before the CAS
--
-- A call approved by hand (client / advisor confirmed, dated on or after the latest
-- CAS) is not in any CAS yet. Until now "In bank" ignored it, so the money box only
-- moved when the next CAS arrived. Now:
--   in_bank       = fresh money + CAS-confirmed sold - bought + approved sold - approved bought
--   in_bank_cas   = the old figure (CAS-confirmed only), for "as per last CAS"
--   approved_sold / approved_bought = the approved part, so "In funds" can move too
--     (in funds now = live value - approved sold + approved bought; done in the app,
--      next to the live value it adjusts).
-- The next CAS that shows the trade verifies the same execution (see reconciliation),
-- so it moves from "approved" to "CAS-confirmed" without being counted twice.
--
-- executions.cas_missing_ack_on: the CAS date up to which a person chose "Keep waiting"
-- for an approved trade that CAS did not show (asked once per CAS in the CAS inbox).
-- =============================================================================

alter table public.executions add column if not exists cas_missing_ack_on date;

comment on column public.executions.cas_missing_ack_on is
  'Approved (hand-recorded) trade not shown by the CAS of this date: a person chose to keep waiting for a later CAS.';

-- SIP lines approved by hand can be undone (see the waiting page); same rules otherwise.
create or replace function app.guard_sip_item()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_plan record;
  v_row record;
begin
  v_row := case when tg_op = 'DELETE' then old else new end;
  select client_id, status into v_plan from public.advisory_plans where id = v_row.plan_id;

  if tg_op = 'DELETE' then
    if v_plan.status <> 'DRAFT' then
      raise exception 'SIP items of an approved plan cannot be deleted; cancel them instead' using errcode = '42501';
    end if;
    return old;
  end if;

  new.client_id := v_plan.client_id;
  if v_plan.status in ('COMPLETED', 'REPLACED', 'CANCELLED') and tg_op = 'INSERT' then
    raise exception 'Plan is % and can no longer be edited', v_plan.status using errcode = '42501';
  end if;

  if v_plan.status <> 'DRAFT' and tg_op = 'UPDATE' then
    perform app.assert_unchanged(to_jsonb(old), to_jsonb(new),
      array['id', 'plan_id', 'client_id', 'created_at', 'created_by'], 'sip_plan_items');
    if (new.security_id, new.action, new.old_amount, new.new_amount, new.frequency)
       is distinct from (old.security_id, old.action, old.old_amount, old.new_amount, old.frequency)
       and app.audit_reason() is null then
      raise exception 'Amending a SIP item of an approved plan requires a reason' using errcode = '23514';
    end if;
  end if;
  if v_plan.status = 'ACTIVE' and tg_op = 'INSERT' and app.audit_reason() is null then
    raise exception 'Adding a SIP item to an ACTIVE plan requires a reason' using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    -- A SIP line approved by hand on the waiting page (no CAS has shown it yet) can be undone:
    -- back to ADVISED, once. Anything else that is done or cancelled stays so.
    if old.status = 'COMPLETED' and new.status = 'ADVISED'
       and coalesce(old.notes, '') like '%Approved on the waiting page%'
       and coalesce(old.notes, '') not like '%Verified from CAS%' then
      new.completed_at := null;
    elsif old.status in ('COMPLETED', 'CANCELLED') then
      raise exception 'SIP item is % and cannot change status', old.status using errcode = '42501';
    end if;
    if v_plan.status = 'DRAFT' and new.status in ('ADVISED', 'COMPLETED') then
      raise exception 'SIP actions can only progress once the plan is ACTIVE' using errcode = '42501';
    end if;
    if new.status = 'ADVISED' then new.advised_at := coalesce(new.advised_at, now()); end if;
    if new.status = 'COMPLETED' then
      new.advised_at := coalesce(new.advised_at, now());
      new.completed_at := coalesce(new.completed_at, now());
    end if;
  end if;
  return new;
end;
$$;

create or replace view public.v_client_bank
with (security_invoker = true) as
select
  x.client_id,
  greatest(0, x.fresh_money + x.sold + x.approved_sold - x.bought - x.approved_bought)::numeric(18,2) as in_bank,
  x.sold::numeric(18,2) as sold_in_cas,
  x.bought::numeric(18,2) as bought_in_cas,
  x.fresh_money::numeric(18,2) as fresh_money,
  greatest(x.cash_at_onboarding, -x.fresh_money)::numeric(18,2) as cash_at_onboarding,
  greatest(0, x.fresh_money + x.sold - x.bought)::numeric(18,2) as in_bank_cas,
  x.approved_sold::numeric(18,2) as approved_sold,
  x.approved_bought::numeric(18,2) as approved_bought,
  x.approved_count::int as approved_count
from (
  select
    c.id as client_id,
    coalesce((select sum(f.amount) from public.client_fresh_money f where f.client_id = c.id), 0) as fresh_money,
    coalesce(t.sold, 0) as sold,
    coalesce(t.bought, 0) as bought,
    coalesce(t.cash_at_onboarding, 0) as cash_at_onboarding,
    coalesce(t.approved_sold, 0) as approved_sold,
    coalesce(t.approved_bought, 0) as approved_bought,
    coalesce(t.approved_count, 0) as approved_count
  from public.clients c
  left join lateral (
    select
      sum(e.executed_amount) filter (where e.in_cas and ai.action = 'SELL') as sold,
      sum(e.executed_amount) filter (where e.in_cas and ai.action = 'BUY') as bought,
      sum(case when ai.action = 'BUY' then -e.executed_amount else e.executed_amount end)
        filter (where e.in_cas and e.execution_date < (select s.snapshot_date from public.portfolio_snapshots s where s.client_id = c.id and s.is_baseline)) as cash_at_onboarding,
      sum(e.executed_amount) filter (where e.approved and ai.action = 'SELL') as approved_sold,
      sum(e.executed_amount) filter (where e.approved and ai.action = 'BUY') as approved_bought,
      count(*) filter (where e.approved) as approved_count
    from (
      select e.*, e.in_cas_ as in_cas,
             -- Approved: confirmed by the client or advisor (the waiting page, or by hand), not in the CAS
             -- figures yet. "Done before onboarding" (PROOF_VERIFIED, proof = that CAS) is not an approval.
             (not e.in_cas_ and e.verification_type in ('CLIENT_CONFIRMED', 'ADVISOR_CONFIRMED')) as approved
      from (
        select e.*,
               -- In the CAS figures: verified by a CAS, or dated before the latest CAS (which then includes it).
               coalesce(e.cas_verified_at is not null
                or e.execution_date < (select l.snapshot_date from public.v_latest_snapshot l where l.client_id = c.id), false) as in_cas_
        from public.executions e
        where e.client_id = c.id and e.status in ('EXECUTED', 'PARTIAL')
      ) e
    ) e
    join public.advice_items ai on ai.id = e.advice_item_id
  ) t on true
  where c.deleted_at is null
) x;

grant select on public.v_client_bank to authenticated;
