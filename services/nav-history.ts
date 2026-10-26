/**
 * Past NAVs (nav_history) for the quarterly review: each held fund and each
 * benchmark's index fund. Fetched once per scheme from the public NAV history
 * (api.mfapi.in, which mirrors AMFI) and kept fresh afterwards by the daily NAV
 * feed (ingestNavFeed appends every code already here). A failed fetch is logged
 * in nav_history_fetches and never blocks the report; the index columns just stay
 * blank and the review says so.
 */
import type { Tx } from "@/lib/db/tx";
import { parseNavHistory, type NavPoint } from "@/lib/parsers/nav-history";

export const NAV_HISTORY_URL = "https://api.mfapi.in/mf/";
const CHUNK = 1000;
/** Keep this much history (the 5-year page plus a year either side). */
const KEEP_YEARS = 7;

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Download one scheme's history. Throws on a network error, a non-200 or a bad body. */
export async function downloadNavHistory(code: string, fetcher: Fetcher = fetch, timeoutMs = 20_000): Promise<NavPoint[]> {
  if (!/^\d{3,8}$/.test(code)) throw new Error("bad AMFI code");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetcher(`${NAV_HISTORY_URL}${code}`, { signal: ctl.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`NAV history: HTTP ${res.status}`);
    const parsed = parseNavHistory(await res.json());
    if (parsed.code !== code) throw new Error("NAV history: answer is for another scheme");
    return parsed.points;
  } finally {
    clearTimeout(timer);
  }
}

/** Store a download (or its failure) for one code. */
export async function storeNavHistory(tx: Tx, code: string, points: NavPoint[] | null, error: string | null = null): Promise<number> {
  const floor = `${new Date().getUTCFullYear() - KEEP_YEARS}-01-01`;
  const keep = (points ?? []).filter((p) => p.date >= floor);
  for (let i = 0; i < keep.length; i += CHUNK) {
    const rows = keep.slice(i, i + CHUNK).map((p) => ({ amfi_code: code, nav_date: p.date, nav: p.nav }));
    await tx`insert into public.nav_history ${tx(rows)} on conflict (amfi_code, nav_date) do update set nav = excluded.nav`;
  }
  await tx`
    insert into public.nav_history_fetches (amfi_code, fetched_at, first_date, last_date, rows_stored, error)
    select ${code}, now(), min(nav_date), max(nav_date), count(*)::int, ${error}
    from public.nav_history where amfi_code = ${code}
    on conflict (amfi_code) do update set fetched_at = now(), first_date = excluded.first_date, last_date = excluded.last_date,
      rows_stored = excluded.rows_stored, error = excluded.error`;
  return keep.length;
}

/**
 * Codes whose history should be (re)fetched to cover `needFrom` .. `needTo`: never fetched,
 * not reaching back far enough, or behind by more than a few days. A recent attempt (an hour for a
 * failure, six hours otherwise) is not repeated.
 */
export async function codesToFetch(tx: Tx, codes: string[], needFrom: string, needTo: string): Promise<string[]> {
  const uniq = [...new Set(codes.filter((c) => /^\d{3,8}$/.test(c)))];
  if (!uniq.length) return [];
  const rows = await tx<{ amfi_code: string; fresh: boolean; covers: boolean }[]>`
    select amfi_code,
           fetched_at > now() - (case when error is null then interval '6 hours' else interval '1 hour' end) as fresh,
           (error is null and first_date <= ${needFrom}::date + 7 and last_date >= ${needTo}::date - 4) as covers
    from public.nav_history_fetches where amfi_code = any(${uniq}::text[])`;
  const seen = new Map(rows.map((r) => [r.amfi_code, r]));
  return uniq.filter((c) => {
    const r = seen.get(c);
    return !r || (!r.covers && !r.fresh);
  });
}

/** Fetch what is missing, a few at a time; `write` runs one transaction per code. */
export async function ensureNavHistory(
  write: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>,
  codes: string[],
  needFrom: string,
  needTo: string,
  fetcher: Fetcher = fetch,
): Promise<{ fetched: string[]; failed: string[] }> {
  const todo = await write((tx) => codesToFetch(tx, codes, needFrom, needTo));
  const fetched: string[] = [];
  const failed: string[] = [];
  const queue = [...todo];
  const worker = async () => {
    for (let code = queue.shift(); code; code = queue.shift()) {
      try {
        const points = await downloadNavHistory(code, fetcher);
        await write((tx) => storeNavHistory(tx, code, points));
        fetched.push(code);
      } catch (e) {
        const msg = (e as Error).name === "AbortError" ? "timed out" : (e as Error).message.slice(0, 200);
        await write((tx) => storeNavHistory(tx, code, null, msg));
        failed.push(code);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
  return { fetched, failed };
}

/** NAVs of these codes between two dates, oldest first, by code. */
export async function navSeries(tx: Tx, codes: string[], from: string, to: string): Promise<Map<string, NavPoint[]>> {
  const out = new Map<string, NavPoint[]>();
  const uniq = [...new Set(codes)];
  if (!uniq.length) return out;
  const rows = await tx<{ amfi_code: string; d: string; nav: number }[]>`
    select amfi_code, nav_date::text as d, nav::float8 as nav from public.nav_history
    where amfi_code = any(${uniq}::text[]) and nav_date between ${from}::date and ${to}::date
    order by amfi_code, nav_date`;
  for (const r of rows) {
    const list = out.get(r.amfi_code) ?? [];
    list.push({ date: r.d, nav: r.nav });
    out.set(r.amfi_code, list);
  }
  return out;
}

/**
 * The daily NAV feed records today's NAV for every benchmark index fund, every fund a client holds and
 * every code already fetched, so history builds up from the feed even if the history source is down.
 */
export async function appendTrackedNavs(tx: Tx): Promise<number> {
  const res = await tx`
    with tracked as (
      select amfi_code as code from public.nav_history_fetches
      union select index_fund_amfi_code from public.benchmark_indices
      union select m.amfi_code from public.portfolio_holdings h
            join public.v_latest_snapshot l on l.snapshot_id = h.snapshot_id
            join public.mf_schemes m on m.isin = h.isin
    )
    insert into public.nav_history (amfi_code, nav_date, nav)
    select distinct on (ms.amfi_code) ms.amfi_code, ms.nav_date, ms.nav
    from public.mf_schemes ms join tracked t on t.code = ms.amfi_code
    where ms.nav is not null and ms.nav_date is not null
    order by ms.amfi_code, ms.nav_date desc
    on conflict (amfi_code, nav_date) do nothing`;
  await tx`
    update public.nav_history_fetches f set last_date = h.last
    from (select amfi_code, max(nav_date) as last from public.nav_history group by amfi_code) h
    where h.amfi_code = f.amfi_code and h.last > coalesce(f.last_date, '1900-01-01')`;
  return res.count;
}
