-- =============================================================================
-- 0024 Questions from the report.
--
-- When the report's wording for a fund cannot be read as Buy, Sell or Keep
-- (a trim with no amount or percentage, an unclear word, a condition), the
-- line is a Keep that needs review and carries the question for the desk.
-- The advisor's answer (Buy / Sell / Keep, amount, explanation) is kept on the
-- line. A DRAFT plan cannot be approved while a question is open (needs_review).
--
-- Older plans kept such trims as a Keep with a note: they become questions too.
-- =============================================================================

alter table public.advisory_plan_items
  add column report_question text check (report_question is null or length(report_question) <= 500),
  add column report_answer text check (report_answer is null or length(report_answer) <= 2000);

comment on column public.advisory_plan_items.report_question is 'What the desk must explain to turn the report''s wording into Buy / Sell / Keep (null: read without doubt).';
comment on column public.advisory_plan_items.report_answer is 'The advisor''s explanation when answering report_question.';

do $$ begin perform set_config('app.audit_reason', 'Trims without an amount turned into questions for the desk', true); end $$;

update public.advisory_plan_items pi set
  report_question = 'The report says trim / reduce but gives no amount or percentage. How much should be sold?',
  reason = 'Report: Trim (no amount given)',
  needs_review = true
from public.advisory_plans p
where p.id = pi.plan_id and p.status in ('DRAFT', 'ACTIVE')
  and pi.action = 'RETAIN' and pi.status = 'OPEN'
  and pi.reason like 'TRIM advised in the report, amount not stated%';
