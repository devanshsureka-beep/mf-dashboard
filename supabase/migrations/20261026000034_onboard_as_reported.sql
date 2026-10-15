-- =============================================================================
-- "Onboard with the report as it is": the desk accepts that the advisory report
-- and the CAS differ (e.g. the client is advised on ₹50L of a ₹1Cr portfolio).
-- The plan follows the report; what was accepted is kept on the plan:
--   { "reason": text, "points": [text], "outside": [{scheme_name, isin, folio_number, value}],
--     "by": uuid, "at": timestamptz }
-- "outside" are CAS funds the report does not cover: not plan lines, and their
-- trades in later CAS files are not trades to decide. Set once, never changed.
-- =============================================================================

alter table public.advisory_plans add column as_reported jsonb;

alter table public.advisory_plans add constraint advisory_plans_as_reported_shape check (
  as_reported is null or (
    jsonb_typeof(as_reported) = 'object'
    and length(coalesce(as_reported->>'reason', '')) between 3 and 500
    and jsonb_typeof(coalesce(as_reported->'points', '[]'::jsonb)) = 'array'
    and jsonb_typeof(coalesce(as_reported->'outside', '[]'::jsonb)) = 'array'
  ));

create or replace function app.guard_plan_as_reported()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.as_reported is distinct from old.as_reported then
    raise exception 'advisory_plans: as_reported is set when the plan is created and never changed' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger advisory_plans_as_reported_guard
  before update on public.advisory_plans
  for each row execute function app.guard_plan_as_reported();

comment on column public.advisory_plans.as_reported is
  'Onboarded with the report as it is: reason, the differences accepted, and the CAS funds outside the advised portfolio.';
