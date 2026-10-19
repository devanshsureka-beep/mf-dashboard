-- Edit holdings: a person corrects the client's current holdings (units, folio, a fund the CAS
-- missed or one sold since). A correction never touches a CAS: it is a NEW confirmed snapshot
-- (source MANUAL, no CAS document) flagged is_correction, which becomes the latest holdings.
-- Everything that needs a real CAS (tranche closing, CAS matching, SIP status, "last CAS")
-- skips corrections; values, allocation and the bank figure use them.

alter table public.portfolio_snapshots
  add column if not exists is_correction boolean not null default false,
  add column if not exists correction_of uuid references public.portfolio_snapshots (id);

alter table public.portfolio_snapshots
  add constraint portfolio_snapshots_correction_check
  check (not is_correction or (source = 'MANUAL' and cas_document_id is null and not is_baseline and correction_of is not null));

-- Same guard as before, plus: whether a snapshot is a correction (and of what) never changes.
create or replace function app.guard_snapshot()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform app.assert_unchanged(to_jsonb(old), to_jsonb(new),
    array['id', 'client_id', 'cas_document_id', 'source', 'extraction_method', 'created_at', 'created_by',
          'is_correction', 'correction_of'],
    'portfolio_snapshots');

  if old.review_status <> 'PENDING_REVIEW' then
    perform app.assert_unchanged(to_jsonb(old), to_jsonb(new),
      array['snapshot_date', 'total_invested_value', 'total_current_value', 'review_status',
            'reviewed_at', 'reviewed_by', 'holdings_count'],
      'portfolio_snapshots (reviewed)');
    if old.is_baseline and not new.is_baseline then
      raise exception 'Baseline flag cannot be removed' using errcode = '42501';
    end if;
  end if;

  if new.review_status is distinct from old.review_status then
    new.reviewed_at := coalesce(new.reviewed_at, now());
    new.reviewed_by := coalesce(new.reviewed_by, auth.uid());
  end if;
  return new;
end;
$$;
