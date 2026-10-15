import type { Tx } from "@/lib/db/tx";

/**
 * The CAS inbox: every CAS moves Reading → Check what we read → Unadvised
 * Trades → Done. A CAS marks advised trades done by itself; unclear matches
 * wait under "Check" for one click. Plus the clients whose CAS we should
 * collect. RLS decides which clients the user sees.
 */

export interface InboxReading { cas_id: string; client_id: string; client_name: string; uploaded_at: Date; status: string; error: string | null }
export interface InboxCheck { snapshot_id: string; cas_id: string | null; client_id: string; client_name: string; client_code: string; snapshot_date: string; value: number; funds: number; warnings: number }
export interface InboxUnadvised { run_id: string; client_id: string; client_name: string; client_code: string; snapshot_date: string; trades: number; amount: number; matched: number }
export interface InboxDone { client_id: string; client_name: string; snapshot_date: string; run_id: string | null; verified: number; unadvised_reviewed: number }
export interface InboxConfirm { run_id: string; client_id: string; client_name: string; client_code: string; snapshot_date: string; matches: number; first: string | null }
export interface InboxCollect { client_id: string; client_name: string; client_code: string; phone: string | null; latest_cas: string | null; waiting_amount: number; unverified_amount: number; days: number | null }

export async function getCasInbox(tx: Tx) {
  const reading = await tx<InboxReading[]>`
    select cd.id as cas_id, cd.client_id, c.full_name as client_name, cd.uploaded_at, cd.parse_status as status, cd.parse_error as error
    from public.cas_documents cd join public.clients c on c.id = cd.client_id
    where cd.parse_status in ('UPLOADED', 'PROCESSING', 'FAILED')
      and cd.uploaded_at > now() - interval '14 days'
      and not exists (select 1 from public.portfolio_snapshots s where s.cas_document_id = cd.id)
    order by cd.uploaded_at desc limit 20`;

  // Newest unchecked CAS per client (older unchecked ones are superseded).
  const check = await tx<InboxCheck[]>`
    select distinct on (s.client_id) s.id as snapshot_id, s.cas_document_id as cas_id, s.client_id, c.full_name as client_name, c.client_code,
           s.snapshot_date::text as snapshot_date, s.total_current_value::float8 as value,
           (select count(*)::int from public.portfolio_holdings h where h.snapshot_id = s.id) as funds,
           coalesce(jsonb_array_length(cd.parse_warnings), 0)::int as warnings
    from public.portfolio_snapshots s join public.clients c on c.id = s.client_id
    left join public.cas_documents cd on cd.id = s.cas_document_id
    where s.review_status = 'PENDING_REVIEW'
    order by s.client_id, s.snapshot_date desc, s.created_at desc`;

  // Advised trades the CAS seems to show, but not clearly enough to mark done alone.
  const confirm = await tx<InboxConfirm[]>`
    select r.id as run_id, r.client_id, c.full_name as client_name, c.client_code, cs.snapshot_date::text as snapshot_date,
           count(m.id)::int as matches, min(m.scheme_name) as first
    from public.reconciliation_runs r join public.clients c on c.id = r.client_id
    join public.portfolio_snapshots cs on cs.id = r.current_snapshot_id
    join public.reconciliation_matches m on m.run_id = r.id and m.classification = 'ADVICE_MATCH' and m.status = 'SUGGESTED'
    where r.status <> 'CANCELLED'
    group by r.id, r.client_id, c.full_name, c.client_code, cs.snapshot_date
    order by cs.snapshot_date desc`;

  const unadvised = await tx<InboxUnadvised[]>`
    select r.id as run_id, r.client_id, c.full_name as client_name, c.client_code, cs.snapshot_date::text as snapshot_date,
           count(m.id) filter (where m.classification = 'UNADVISED' and m.status in ('UNEXPLAINED', 'SUGGESTED') and m.reviewed_at is null)::int as trades,
           coalesce(sum(abs(coalesce(m.transaction_amount, m.approx_amount))) filter (where m.classification = 'UNADVISED' and m.status in ('UNEXPLAINED', 'SUGGESTED') and m.reviewed_at is null), 0)::float8 as amount,
           count(m.id) filter (where m.classification = 'ADVICE_MATCH' and m.status in ('CONFIRMED', 'PARTIAL'))::int as matched
    from public.reconciliation_runs r join public.clients c on c.id = r.client_id
    join public.portfolio_snapshots cs on cs.id = r.current_snapshot_id
    left join public.reconciliation_matches m on m.run_id = r.id
    where r.status <> 'CANCELLED'
    group by r.id, r.client_id, c.full_name, c.client_code, cs.snapshot_date
    having count(m.id) filter (where m.classification = 'UNADVISED' and m.status in ('UNEXPLAINED', 'SUGGESTED') and m.reviewed_at is null) > 0
    order by cs.snapshot_date desc`;

  // Confirmed CAS of the last 30 days with nothing left to review.
  const done = await tx<InboxDone[]>`
    select s.client_id, c.full_name as client_name, s.snapshot_date::text as snapshot_date, r.id as run_id,
           (select count(*)::int from public.reconciliation_matches m where m.run_id = r.id and m.classification = 'ADVICE_MATCH' and m.status in ('CONFIRMED', 'PARTIAL')) as verified,
           (select count(*)::int from public.reconciliation_matches m where m.run_id = r.id and m.classification = 'UNADVISED' and (m.reviewed_at is not null or m.status not in ('UNEXPLAINED', 'SUGGESTED'))) as unadvised_reviewed
    from public.portfolio_snapshots s join public.clients c on c.id = s.client_id
    left join public.reconciliation_runs r on r.current_snapshot_id = s.id and r.status <> 'CANCELLED'
    where s.review_status = 'CONFIRMED' and coalesce(s.reviewed_at, s.created_at) > now() - interval '30 days'
      and not exists (select 1 from public.reconciliation_matches m where m.run_id = r.id and m.classification = 'UNADVISED'
                      and m.status in ('UNEXPLAINED', 'SUGGESTED') and m.reviewed_at is null)
    order by coalesce(s.reviewed_at, s.created_at) desc limit 30`;

  // Advice no CAS has shown yet, or no CAS for 30+ days.
  const collect = await tx<InboxCollect[]>`
    select c.id as client_id, c.full_name as client_name, c.client_code, c.phone, l.snapshot_date::text as latest_cas,
           coalesce(w.amount, 0)::float8 as waiting_amount,
           coalesce((select sum(e.executed_amount) from public.executions e
                     where e.client_id = c.id and e.status in ('EXECUTED', 'PARTIAL') and e.cas_verified_at is null
                       and e.execution_date >= coalesce(l.snapshot_date, '-infinity'::date)), 0)::float8 as unverified_amount,
           (app.today_ist() - l.snapshot_date)::int as days
    from public.clients c
    left join public.v_latest_snapshot l on l.client_id = c.id
    left join (select client_id, sum(pending_amount) as amount from public.v_pending_executions group by client_id) w on w.client_id = c.id
    where c.status <> 'CLOSED' and c.deleted_at is null
    order by c.full_name`;

  return {
    reading,
    check,
    confirm,
    unadvised,
    done,
    collect: collect
      .filter((x) => x.waiting_amount >= 0.5 || x.unverified_amount >= 0.5 || x.days == null || x.days > 30)
      .sort((a, b) => b.waiting_amount + b.unverified_amount - (a.waiting_amount + a.unverified_amount) || (b.days ?? 9999) - (a.days ?? 9999)),
  };
}

/** What one CAS matching run did by itself and what it left for a person (for the inbox cards). */
export interface InboxRunDetail {
  run_id: string;
  previous_date: string | null;
  sip_lines_ticked: number;
  /** Calls the CAS shows done (confirmed by itself or by a person). */
  done: { scheme_name: string; action: string | null }[];
  /** Calls the CAS seems to show, waiting for a click. */
  suggested: { id: string; scheme_name: string; action: string | null; amount: number; date: string | null }[];
  /** CAS trades no call explains, not yet reviewed. */
  unadvised: { id: string; scheme_name: string; change_type: string; amount: number; date: string | null; single_trade: boolean }[];
}

export async function getInboxRunDetails(tx: Tx, runIds: string[]): Promise<Record<string, InboxRunDetail>> {
  if (!runIds.length) return {};
  const runs = await tx<{ run_id: string; previous_date: string | null; sip_lines_ticked: number }[]>`
    select r.id as run_id, ps.snapshot_date::text as previous_date, coalesce((r.summary->>'sip_items_completed')::int, 0) as sip_lines_ticked
    from public.reconciliation_runs r left join public.portfolio_snapshots ps on ps.id = r.previous_snapshot_id
    where r.id = any(${runIds}::uuid[])`;
  const rows = await tx<{ id: string; run_id: string; scheme_name: string; classification: string; status: string; reviewed: boolean; action: string | null;
    change_type: string; amount: number; date: string | null; single_trade: boolean }[]>`
    select m.id, m.run_id, m.scheme_name, m.classification, m.status, m.reviewed_at is not null as reviewed, a.action, m.change_type,
           abs(coalesce(m.transaction_amount, m.approx_amount))::float8 as amount, m.transaction_date::text as date,
           (m.cas_transaction_id is not null and coalesce(m.transaction_amount, 0) > 0) as single_trade
    from public.reconciliation_matches m left join public.advice_items a on a.id = m.advice_item_id
    where m.run_id = any(${runIds}::uuid[]) and m.classification in ('ADVICE_MATCH', 'UNADVISED')
    order by m.transaction_date nulls last, m.scheme_name`;
  const out: Record<string, InboxRunDetail> = {};
  for (const r of runs) out[r.run_id] = { ...r, done: [], suggested: [], unadvised: [] };
  for (const m of rows) {
    const d = out[m.run_id];
    if (!d) continue;
    if (m.classification === "ADVICE_MATCH" && (m.status === "CONFIRMED" || m.status === "PARTIAL")) d.done.push({ scheme_name: m.scheme_name, action: m.action });
    else if (m.classification === "ADVICE_MATCH" && m.status === "SUGGESTED") d.suggested.push({ id: m.id, scheme_name: m.scheme_name, action: m.action, amount: m.amount, date: m.date });
    else if (m.classification === "UNADVISED" && (m.status === "UNEXPLAINED" || m.status === "SUGGESTED") && !m.reviewed) {
      d.unadvised.push({ id: m.id, scheme_name: m.scheme_name, change_type: m.change_type, amount: m.amount, date: m.date, single_trade: m.single_trade });
    }
  }
  return out;
}
