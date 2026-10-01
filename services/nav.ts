/**
 * Daily NAV feed: store every AMFI scheme with its latest NAV (mf_schemes) and
 * log the delivery. Valuation itself happens in the v_holding_live view.
 */
import type { Tx } from "@/lib/db/tx";
import type { AmfiScheme } from "@/lib/parsers/amfi-nav";

export interface NavFeedResult {
  runId: string;
  navDate: string | null;
  schemes: number;
  newSchemes: number;
  navsUpdated: number;
  holdingsPriced: number;
  holdingsUnpriced: number;
}

const CHUNK = 1000;

export async function ingestNavFeed(
  tx: Tx,
  feed: { schemes: AmfiScheme[]; navDate: string | null },
  source: string,
): Promise<NavFeedResult> {
  let newSchemes = 0;
  let navsUpdated = 0;
  for (let i = 0; i < feed.schemes.length; i += CHUNK) {
    const rows = feed.schemes.slice(i, i + CHUNK).map((s) => ({
      isin: s.isin, amfi_code: s.amfi_code, scheme_name: s.scheme_name, amc: s.amc, category: s.category,
      plan_type: s.plan_type, option_type: s.option_type, nav: s.nav, nav_date: s.nav_date,
    }));
    // A NAV only ever moves forward in time; names / categories follow the latest file.
    const res = await tx<{ inserted: boolean; nav_changed: boolean }[]>`
      insert into public.mf_schemes ${tx(rows)}
      on conflict (isin) do update set
        amfi_code = excluded.amfi_code,
        scheme_name = excluded.scheme_name,
        amc = coalesce(excluded.amc, mf_schemes.amc),
        category = coalesce(excluded.category, mf_schemes.category),
        plan_type = coalesce(excluded.plan_type, mf_schemes.plan_type),
        option_type = excluded.option_type,
        nav = case when excluded.nav is not null and (mf_schemes.nav_date is null or excluded.nav_date >= mf_schemes.nav_date)
                   then excluded.nav else mf_schemes.nav end,
        nav_date = case when excluded.nav is not null and (mf_schemes.nav_date is null or excluded.nav_date >= mf_schemes.nav_date)
                        then excluded.nav_date else mf_schemes.nav_date end,
        updated_at = now()
      returning (xmax = 0) as inserted, (nav_date = ${feed.navDate}::date) as nav_changed`;
    newSchemes += res.filter((r) => r.inserted).length;
    navsUpdated += res.filter((r) => r.nav_changed).length;
  }

  const cover = await tx<{ priced: number; unpriced: number }[]>`
    select count(*) filter (where is_live)::int as priced, count(*) filter (where not is_live)::int as unpriced
    from public.v_holding_live`;
  const run = await tx<{ id: string }[]>`
    insert into public.nav_feed_runs (source, nav_date, schemes, new_schemes, navs_updated, holdings_priced, holdings_unpriced)
    values (${source}, ${feed.navDate}, ${feed.schemes.length}, ${newSchemes}, ${navsUpdated}, ${cover[0].priced}, ${cover[0].unpriced})
    returning id`;
  return {
    runId: run[0].id, navDate: feed.navDate, schemes: feed.schemes.length, newSchemes, navsUpdated,
    holdingsPriced: cover[0].priced, holdingsUnpriced: cover[0].unpriced,
  };
}

export interface NavStatus { received_at: string; nav_date: string | null; schemes: number; holdings_unpriced: number }

export async function latestNavRun(tx: Tx): Promise<NavStatus | null> {
  const r = await tx<NavStatus[]>`
    select received_at, nav_date, schemes, holdings_unpriced from public.nav_feed_runs order by received_at desc limit 1`;
  return r[0] ?? null;
}
