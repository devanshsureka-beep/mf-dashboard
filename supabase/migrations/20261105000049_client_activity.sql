-- =============================================================================
-- 0049 Active / inactive clients
--
-- Active   = we have advised the client at least once: any call issued (revised or cancelled
--            later still counts; a call recorded from the CAS inbox as "our call" counts), or a
--            SIP line we advised.
-- Inactive = not advised yet (onboarded, a draft plan, or a plan with no call given).
-- Calls created only to record trades done before onboarding (batch note "Done before
-- onboarding…") are not advice and do not count.
-- =============================================================================

create or replace view public.v_client_activity
with (security_invoker = true) as
select
  c.id as client_id,
  (a.first_call_at is not null or s.first_sip_at is not null) as is_active,
  least(a.first_call_at, s.first_sip_at) as first_advised_at,
  coalesce(a.calls, 0)::int as calls
from public.clients c
left join lateral (
  select min(b.communicated_at) as first_call_at, count(distinct ai.id) as calls
  from public.advice_batches b
  join public.advice_items ai on ai.advice_batch_id = b.id
  where b.client_id = c.id and coalesce(b.notes, '') not like 'Done before onboarding%'
) a on true
left join lateral (
  select min(coalesce(sp.advised_at, sp.completed_at)) as first_sip_at
  from public.sip_plan_items sp
  where sp.client_id = c.id
    -- Advised (still waiting), or done after we advised it: approved by hand, or advised before the
    -- CAS ticked it (a line the CAS ticked straight from the report has advised_at = completed_at).
    and (sp.status = 'ADVISED'
         or (sp.status = 'COMPLETED' and (coalesce(sp.notes, '') like '%Approved on the waiting page%'
                                          or sp.advised_at < sp.completed_at - interval '1 minute')))
) s on true
where c.deleted_at is null;

grant select on public.v_client_activity to authenticated;
