/**
 * Fund search for calls: every scheme AMFI publishes (mf_schemes, refreshed by
 * the daily NAV feed) plus funds already known to the desk (security_master,
 * including report-only funds that have no ISIN yet).
 *
 * Option values: "sec:<security_id>" for a known fund, "isin:<ISIN>" for an
 * AMFI scheme not used yet; resolveFundRef() turns the latter into a security.
 */
import type { Tx } from "@/lib/db/tx";
import { AppError } from "@/lib/errors";
import { resolveOrCreateSecurity } from "@/services/securities";

export interface FundOption {
  value: string;
  scheme_name: string;
  isin: string | null;
  amc: string | null;
  category: string | null;
  plan_type: string | null;
  option_type: string | null;
  nav: number | null;
  nav_date: string | null;
}

export async function searchFunds(tx: Tx, q: string, limit = 30): Promise<FundOption[]> {
  const words = q.toLowerCase().replace(/[^a-z0-9&]+/g, " ").trim().split(" ").filter(Boolean).slice(0, 6);
  if (!words.length) return [];
  const isinLike = /^[a-z]{2}[a-z0-9]{2,10}$/.test(words[0]) && words.length === 1 ? `${words[0].toUpperCase()}%` : null;
  const patterns = words.map((w) => `%${w}%`);
  const rows = await tx<(FundOption & { rank: number })[]>`
    with known as (
      select 'sec:' || sm.id as value, sm.scheme_name, sm.isin, sm.amc, sm.category, sm.plan_type, sm.option_type,
             m.nav, m.nav_date, 0 as src
      from public.security_master sm
      left join public.mf_schemes m on m.isin = sm.isin
      where sm.is_active
        and ((${isinLike}::text is not null and sm.isin like ${isinLike})
             or lower(sm.scheme_name || ' ' || coalesce(sm.amc, '')) like all(${patterns}::text[]))
    ),
    amfi as (
      select 'isin:' || m.isin as value, m.scheme_name, m.isin, m.amc, m.category, m.plan_type, m.option_type,
             m.nav, m.nav_date, 1 as src
      from public.mf_schemes m
      where not exists (select 1 from public.security_master sm where sm.isin = m.isin)
        and ((${isinLike}::text is not null and m.isin like ${isinLike})
             or lower(m.scheme_name || ' ' || coalesce(m.amc, '')) like all(${patterns}::text[]))
    )
    select *,
      (case when option_type = 'IDCW' then 2 else 0 end)
      + (case when plan_type = 'REGULAR' then 1 else 0 end)
      + (case when lower(scheme_name) like ${`${words[0]}%`} then 0 else 1 end) as rank
    from (select * from known union all select * from amfi) x
    order by rank, src, scheme_name
    limit ${limit}`;
  return rows.map(({ rank: _rank, ...r }) => r);
}

/** "sec:<uuid>" -> uuid; "isin:<ISIN>" -> security for that AMFI scheme (created on first use). */
export async function resolveFundRef(tx: Tx, ref: string, createdBy: string | null): Promise<string> {
  if (ref.startsWith("sec:")) return ref.slice(4);
  if (/^[0-9a-f-]{36}$/i.test(ref)) return ref;
  if (!ref.startsWith("isin:")) throw new AppError("Unknown fund.");
  const isin = ref.slice(5);
  const m = await tx<{ scheme_name: string; amc: string | null; category: string | null; plan_type: string | null }[]>`
    select scheme_name, amc, category, plan_type from public.mf_schemes where isin = ${isin}`;
  if (!m[0]) throw new AppError("That fund is not in the AMFI list.");
  return resolveOrCreateSecurity(tx, { isin, ...m[0] }, createdBy);
}
