import type { Tx } from "@/lib/db/tx";
import type { BookHolding } from "@/lib/domain/book";

/**
 * The book for the home screen. RLS decides which clients the user sees; `advisorId`
 * narrows to one advisor's clients ("My clients").
 */

/** Every holding of each client's latest confirmed CAS, at today's NAV, with its fund's category and AMC. */
export async function getBookHoldings(tx: Tx, advisorId: string | null): Promise<BookHolding[]> {
  return tx<BookHolding[]>`
    select h.client_id, s.full_name as client_name, s.advisor_name, s.risk_profile, h.security_id,
           coalesce(sm.scheme_name, h.scheme_name) as scheme_name,
           coalesce(m.category, sm.category) as category, coalesce(m.amc, sm.amc) as amc,
           coalesce(h.plan_type, sm.plan_type, m.plan_type) as plan_type,
           h.live_value::float8 as value
    from public.v_holding_live h
    join public.v_client_summary s on s.client_id = h.client_id
    left join public.security_master sm on sm.id = h.security_id
    left join public.mf_schemes m on m.isin = h.isin
    where h.live_value > 0 and (${advisorId}::uuid is null or s.advisor_id = ${advisorId})`;
}

export interface TrendPoint { month: string; value: number; clients: number }

/**
 * Money in funds at the end of each of the last 12 months: each client's latest confirmed CAS
 * on or before that day (CAS values); this month is today's value (units × today's NAV).
 */
export async function getBookTrend(tx: Tx, advisorId: string | null, liveNow: number, clientsNow: number): Promise<TrendPoint[]> {
  const rows = await tx<TrendPoint[]>`
    with months as (
      select (date_trunc('month', app.today_ist()) - make_interval(months => n))::date as m_start
      from generate_series(1, 11) n
    ), snaps as (
      select p.client_id, p.snapshot_date, p.created_at, p.total_current_value
      from public.portfolio_snapshots p join public.v_client_summary s on s.client_id = p.client_id
      where p.review_status = 'CONFIRMED' and (${advisorId}::uuid is null or s.advisor_id = ${advisorId})
    )
    select to_char(mo.m_start, 'YYYY-MM') as month, coalesce(sum(l.v), 0)::float8 as value,
           -- Clients holding something then (a new investor's empty start does not count).
           count(*) filter (where l.v > 0)::int as clients
    from months mo
    left join lateral (
      select distinct on (x.client_id) x.total_current_value as v from snaps x
      where x.snapshot_date <= (mo.m_start + interval '1 month - 1 day')::date
      order by x.client_id, x.snapshot_date desc, x.created_at desc) l on true
    group by mo.m_start order by mo.m_start`;
  const thisMonth = (await tx<{ m: string }[]>`select to_char(app.today_ist(), 'YYYY-MM') as m`)[0].m;
  return [...rows, { month: thisMonth, value: liveNow, clients: clientsNow }];
}
