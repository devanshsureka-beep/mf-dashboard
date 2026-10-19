import type { Tx } from "@/lib/db/tx";
import type { MixRow } from "@/lib/domain/market-cap";

export interface ValuePoint { date: string; value: number; cas: boolean }

/**
 * The client's portfolio picture for the page top:
 * - holdings: the latest confirmed CAS, units × today's NAV (v_holding_live);
 * - planDeltas: what each line of the active plan still has to do (waiting + left to advise),
 *   signed: a sell takes money out of its fund, a buy puts it in; plus trades recorded since the latest CAS;
 * - history: money in funds at each confirmed CAS since onboarding, then today at the latest NAV.
 */
export async function getClientMix(tx: Tx, clientId: string): Promise<{ holdings: MixRow[]; planDeltas: MixRow[]; history: ValuePoint[] }> {
  const holdings = await tx<MixRow[]>`
    select coalesce(sm.scheme_name, h.scheme_name) as name, coalesce(m.category, sm.category) as category,
           coalesce(m.amc, sm.amc) as amc, h.live_value::float8 as value
    from public.v_holding_live h
    left join public.security_master sm on sm.id = h.security_id
    left join public.mf_schemes m on m.isin = coalesce(h.isin, sm.isin)
    where h.client_id = ${clientId} and h.live_value > 0`;
  const planDeltas = await tx<MixRow[]>`
    select coalesce(sm.scheme_name, v.scheme_name) as name, coalesce(m.category, sm.category) as category,
           coalesce(m.amc, sm.amc) as amc,
           ((case when v.side = 'SELL' then -1 else 1 end)
             * (coalesce(v.pending_amount, 0) + coalesce(v.yet_to_advise_amount, 0)))::float8 as value
    from public.v_plan_item_progress v
    left join public.security_master sm on sm.id = v.security_id
    left join public.mf_schemes m on m.isin = sm.isin
    where v.client_id = ${clientId} and v.plan_status = 'ACTIVE' and v.side in ('SELL', 'BUY')
      and v.item_status <> 'CANCELLED'
      and coalesce(v.pending_amount, 0) + coalesce(v.yet_to_advise_amount, 0) > 0.5`;
  // Trades recorded after the latest CAS are not in its holdings yet (nor in "waiting"): they count towards "after".
  const since = await tx<MixRow[]>`
    select coalesce(sm.scheme_name, '') as name, coalesce(m.category, sm.category) as category, coalesce(m.amc, sm.amc) as amc,
           sum(case when a.action = 'BUY' then e.executed_amount else -e.executed_amount end)::float8 as value
    from public.executions e
    join public.advice_items a on a.id = e.advice_item_id
    join public.security_master sm on sm.id = e.security_id
    left join public.mf_schemes m on m.isin = sm.isin
    where e.client_id = ${clientId} and e.status in ('EXECUTED', 'PARTIAL') and e.executed_amount > 0
      and e.execution_date > coalesce((select l.snapshot_date from public.v_latest_snapshot l where l.client_id = ${clientId}), '-infinity'::date)
    group by 1, 2, 3`;
  planDeltas.push(...since.filter((r) => Math.abs(r.value) > 0.5));
  const snaps = await tx<{ date: string; value: number }[]>`
    select distinct on (p.snapshot_date) p.snapshot_date::text as date, p.total_current_value::float8 as value
    from public.portfolio_snapshots p
    where p.client_id = ${clientId} and p.review_status = 'CONFIRMED'
      and not (p.source = 'MANUAL' and coalesce(p.total_current_value, 0) = 0)
      and p.snapshot_date >= coalesce((select b.snapshot_date from public.portfolio_snapshots b
                                       where b.client_id = ${clientId} and b.is_baseline limit 1), '-infinity'::date)
    order by p.snapshot_date, p.created_at desc`;
  const today = (await tx<{ d: string }[]>`select app.today_ist()::text as d`)[0].d;
  const live = holdings.reduce((t, h) => t + h.value, 0);
  const history: ValuePoint[] = snaps.map((s) => ({ date: s.date, value: s.value, cas: true }));
  if (history.length && history[history.length - 1].date < today) history.push({ date: today, value: live, cas: false });
  return { holdings, planDeltas, history };
}
