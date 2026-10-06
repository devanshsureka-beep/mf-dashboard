-- =============================================================================
-- Client record for audit: agreements, premium payments and monthly report notes.
--   client_agreements   what the client signed (advisory / fee agreement, risk
--                       profile, consents), when, valid till, and the signed copy
--                       (a client document).
--   client_payments     premium paid for MF Premium: amount, date, period covered,
--                       mode and reference. Corrections are admin-only; nothing is
--                       ever deleted.
--   client_report_notes the advisor's summary / outlook / actions for a client's
--                       monthly report (one per client per month).
--   v_client_premium    per client: total paid, paid till, premium status,
--                       renewal due, agreement status.
-- =============================================================================

create table public.client_agreements (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null references public.clients (id),
  agreement_type text not null check (agreement_type in (
                   'ADVISORY_AGREEMENT', 'FEE_AGREEMENT', 'RISK_PROFILE', 'KYC', 'CONSENT', 'OTHER')),
  title          text not null check (length(trim(title)) > 0),
  reference_no   text,
  signed_on      date,
  valid_from     date,
  valid_to       date,
  status         text not null default 'SIGNED' check (status in ('DRAFT', 'SENT', 'SIGNED', 'EXPIRED', 'TERMINATED')),
  document_id    uuid references public.documents (id),
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid references public.profiles (id),
  check (valid_to is null or valid_from is null or valid_to >= valid_from),
  check (status <> 'SIGNED' or signed_on is not null)
);
create index client_agreements_client_idx on public.client_agreements (client_id, valid_to);

create table public.client_payments (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references public.clients (id),
  amount       numeric(18,2) not null check (amount > 0),
  paid_on      date not null,
  period_from  date,
  period_to    date,
  plan_name    text not null default 'MF Premium',
  mode         text not null default 'UPI' check (mode in ('UPI', 'NEFT', 'RTGS', 'IMPS', 'CARD', 'CHEQUE', 'CASH', 'OTHER')),
  reference    text,
  status       text not null default 'RECEIVED' check (status in ('RECEIVED', 'REFUNDED')),
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid references public.profiles (id),
  check (period_to is null or period_from is null or period_to >= period_from),
  check (paid_on <= app.today_ist() + 1)
);
create index client_payments_client_idx on public.client_payments (client_id, paid_on);

create table public.client_report_notes (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references public.clients (id),
  report_month date not null check (extract(day from report_month) = 1),
  summary      text,
  outlook      text,
  actions      text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid references public.profiles (id),
  unique (client_id, report_month)
);

-- Payments: amounts and dates are fixed once recorded; only an admin with a
-- reason may correct them (a refund is a status change, also with a reason).
create or replace function app.guard_client_payment()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not app.admin_correction() then
    perform app.assert_unchanged(to_jsonb(old), to_jsonb(new),
      array['id', 'client_id', 'amount', 'paid_on', 'period_from', 'period_to', 'plan_name', 'mode', 'reference',
            'status', 'created_at', 'created_by'],
      'client_payments');
  else
    perform app.assert_unchanged(to_jsonb(old), to_jsonb(new), array['id', 'client_id', 'created_at', 'created_by'], 'client_payments');
  end if;
  return new;
end;
$$;

create trigger client_payments_guard before update on public.client_payments
  for each row execute function app.guard_client_payment();

do $$
declare
  t text;
begin
  foreach t in array array['client_agreements', 'client_payments', 'client_report_notes'] loop
    execute format('create trigger %I before update on public.%I for each row execute function app.touch_updated_at()', t || '_touch_updated_at', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function app.audit_row_change()', t || '_audit', t);
    execute format('create trigger %I before delete on public.%I for each row execute function app.forbid_delete()', t || '_no_delete', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('create policy %I on public.%I for select to authenticated using (app.can_access_client(client_id))', t || '_select', t);
  end loop;
end $$;

-- Agreements and payments: advisors and operations record them; report notes: advisors.
create policy client_agreements_insert on public.client_agreements for insert to authenticated
  with check (app.can_operate_client(client_id) and created_by = (select auth.uid()));
create policy client_agreements_update on public.client_agreements for update to authenticated
  using (app.can_operate_client(client_id)) with check (app.can_operate_client(client_id));
create policy client_payments_insert on public.client_payments for insert to authenticated
  with check (app.can_operate_client(client_id) and created_by = (select auth.uid()));
create policy client_payments_update on public.client_payments for update to authenticated
  using (app.can_operate_client(client_id)) with check (app.can_operate_client(client_id));
create policy client_report_notes_insert on public.client_report_notes for insert to authenticated
  with check (app.can_advise_client(client_id) and created_by = (select auth.uid()));
create policy client_report_notes_update on public.client_report_notes for update to authenticated
  using (app.can_advise_client(client_id)) with check (app.can_advise_client(client_id));

create or replace view public.v_client_premium
with (security_invoker = true) as
select
  c.id as client_id,
  coalesce(p.total_paid, 0)::numeric(18,2) as premium_paid_total,
  coalesce(p.payments, 0) as premium_payments,
  p.last_paid_on,
  p.paid_until,
  (case
     when p.paid_until is not null and p.paid_until >= app.today_ist() then 'ACTIVE'
     when p.paid_until is not null then 'EXPIRED'
     when coalesce(p.payments, 0) > 0 then 'PAID'
     else 'UNPAID'
   end) as premium_status,
  (p.paid_until is not null and p.paid_until between app.today_ist() and app.today_ist() + 30) as renewal_due,
  coalesce(a.signed, 0) as agreements_signed,
  a.valid_to as agreement_valid_to,
  (case
     when coalesce(a.signed, 0) = 0 then 'NONE'
     when a.valid_to is null or a.valid_to >= app.today_ist() then 'VALID'
     else 'EXPIRED'
   end) as agreement_status
from public.clients c
left join lateral (
  select sum(amount) filter (where status = 'RECEIVED') as total_paid,
         count(*) filter (where status = 'RECEIVED') as payments,
         max(paid_on) filter (where status = 'RECEIVED') as last_paid_on,
         max(period_to) filter (where status = 'RECEIVED') as paid_until
  from public.client_payments where client_id = c.id
) p on true
left join lateral (
  select count(*) as signed,
         (case when bool_or(valid_to is null) then null else max(valid_to) end) as valid_to
  from public.client_agreements
  where client_id = c.id and status = 'SIGNED' and agreement_type in ('ADVISORY_AGREEMENT', 'FEE_AGREEMENT')
) a on true;

comment on view public.v_client_premium is
  'Per client: MF Premium paid (total, last payment, paid until, status, renewal due in 30 days) and advisory agreement status.';

grant select on public.v_client_premium to authenticated;
