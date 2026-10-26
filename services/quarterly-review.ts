/**
 * Quarterly review: gathers a client's numbers for lib/domain/quarterly-report.ts, and keeps the
 * advisor's inputs (quarterly_reviews), the quarter's market valuations (market_context), the index
 * each fund is compared with (fund_benchmarks) and every PDF downloaded (quarterly_review_files).
 */
import type { Actor, Tx } from "@/lib/db/tx";
import { AppError } from "@/lib/errors";
import type { MixRow } from "@/lib/domain/market-cap";
import { addDaysIso, isQuarterEnd, quarterEndOnOrBefore } from "@/lib/domain/quarterly";
import { readInputs, readMarket, MarketContext, QuarterlyInputs, type MarketContext as MarketData, type QuarterlyInputs as Inputs } from "@/lib/domain/quarterly-inputs";
import type { Benchmark, RawFund, RawPlanLine, RawReview, RawSip, RawSoldFund, RawTxn } from "@/lib/domain/quarterly-report";
import { getClientMix } from "./client-mix";
import { navSeries } from "./nav-history";

export interface ReviewFile { id: string; quarter_end: string; file_name: string; as_of: string; created_at: Date; created_by_name: string | null; file_path: string }
export interface QuarterContext { reviewId: string | null; inputs: Inputs; carriedFrom: string | null; market: MarketData; files: ReviewFile[]; updatedAt: Date | null }

/** The quarters a client can have a review for: from onboarding to the last quarter-end, newest first. */
export function reviewQuarters(onboarding: string | null, today: string): string[] {
  const out: string[] = [];
  let q = quarterEndOnOrBefore(today);
  const first = onboarding ? quarterEndOnOrBefore(onboarding) : q;
  while (q >= first && out.length < 40) {
    out.push(q);
    q = quarterEndOnOrBefore(addDaysIso(q.slice(0, 8) + "01", -1));
  }
  return out;
}

function assertQuarter(q: string) {
  if (!isQuarterEnd(q)) throw new AppError("Pick a quarter-end date (31 Mar, 30 Jun, 30 Sep or 31 Dec).");
}

/** Saved inputs for this quarter, else the last review's fund statuses and rates carried over. */
export async function getQuarterContext(tx: Tx, clientId: string, quarterEnd: string): Promise<QuarterContext> {
  assertQuarter(quarterEnd);
  const [row] = await tx<{ id: string; inputs: unknown; updated_at: Date }[]>`
    select id, inputs, updated_at from public.quarterly_reviews where client_id = ${clientId} and quarter_end = ${quarterEnd}`;
  let inputs = readInputs(row?.inputs);
  let carriedFrom: string | null = null;
  if (!row) {
    const [prev] = await tx<{ quarter_end: string; inputs: unknown }[]>`
      select quarter_end::text, inputs from public.quarterly_reviews
      where client_id = ${clientId} and quarter_end < ${quarterEnd} order by quarter_end desc limit 1`;
    if (prev) {
      const p = readInputs(prev.inputs);
      inputs = { funds: p.funds, rates: p.rates, noNewMoney: p.noNewMoney };
      carriedFrom = prev.quarter_end;
    }
  }
  const [m] = await tx<{ data: unknown }[]>`select data from public.market_context where quarter_end = ${quarterEnd}`;
  const files = await tx<ReviewFile[]>`
    select f.id, r.quarter_end::text, f.file_name, f.as_of::text, f.created_at, p.full_name as created_by_name, f.file_path
    from public.quarterly_review_files f join public.quarterly_reviews r on r.id = f.review_id
    left join public.profiles p on p.id = f.created_by
    where f.client_id = ${clientId} and r.quarter_end = ${quarterEnd} order by f.created_at desc`;
  return { reviewId: row?.id ?? null, inputs, carriedFrom, market: readMarket(m?.data), files, updatedAt: row?.updated_at ?? null };
}

export async function saveReviewInputs(tx: Tx, actor: Actor, clientId: string, quarterEnd: string, raw: unknown): Promise<string> {
  assertQuarter(quarterEnd);
  const parsed = QuarterlyInputs.safeParse(raw);
  if (!parsed.success) throw new AppError(`Check the form: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
  const [r] = await tx<{ id: string }[]>`
    insert into public.quarterly_reviews (client_id, quarter_end, inputs, created_by, updated_by)
    values (${clientId}, ${quarterEnd}, ${tx.json(parsed.data as never)}, ${actor.id}, ${actor.id})
    on conflict (client_id, quarter_end) do update set inputs = excluded.inputs, updated_by = excluded.updated_by
    returning id`;
  return r.id;
}

export async function saveMarketContext(tx: Tx, actor: Actor, quarterEnd: string, raw: unknown): Promise<void> {
  assertQuarter(quarterEnd);
  const parsed = MarketContext.safeParse(raw);
  if (!parsed.success) throw new AppError(`Check the market table: ${parsed.error.issues[0]?.message}`);
  await tx`
    insert into public.market_context (quarter_end, data, updated_by) values (${quarterEnd}, ${tx.json(parsed.data as never)}, ${actor.id})
    on conflict (quarter_end) do update set data = excluded.data, updated_by = excluded.updated_by, updated_at = now()`;
}

/** The index a fund is compared with ("" = back to the default, "NONE" = no comparison). */
export async function saveFundBenchmark(tx: Tx, actor: Actor, isin: string, code: string): Promise<void> {
  if (!/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(isin)) throw new AppError("This fund has no ISIN, so its index cannot be set.");
  if (code === "") {
    await tx`delete from public.fund_benchmarks where isin = ${isin}`;
    return;
  }
  const value = code === "NONE" ? null : code;
  if (value && !(await tx`select 1 from public.benchmark_indices where code = ${value}`).length) throw new AppError("Unknown index.");
  await tx`
    insert into public.fund_benchmarks (isin, index_code, set_by) values (${isin}, ${value}, ${actor.id})
    on conflict (isin) do update set index_code = excluded.index_code, set_by = excluded.set_by, set_at = now()`;
}

export async function listBenchmarks(tx: Tx): Promise<Benchmark[]> {
  return tx<Benchmark[]>`select code, name, index_fund_amfi_code as amfi from public.benchmark_indices order by sort, code`;
}

interface Basics { client: RawReview["client"]; onboarding: string | null; activePlanId: string | null; planName: string | null; planStart: string | null; casDate: string; snapshotId: string; today: string }

async function basics(tx: Tx, clientId: string): Promise<Basics> {
  const [c] = await tx<{ id: string; name: string; code: string; onboarding: string | null; plan_id: string | null; plan_name: string | null; plan_start: string | null; cas_date: string | null; snapshot_id: string | null; today: string }[]>`
    select s.client_id as id, s.full_name as name, s.client_code as code, s.onboarding_date::text as onboarding,
           s.active_plan_id as plan_id, s.active_plan_name as plan_name,
           -- The plan's start: its approval, or its first call or trade if earlier (sales often go through first).
           (select least((p.approved_at at time zone 'Asia/Kolkata')::date, p.plan_date,
                         (select min((b.communicated_at at time zone 'Asia/Kolkata')::date) from public.advice_batches b where b.plan_id = p.id),
                         (select min(e.execution_date) from public.executions e join public.advice_items ai on ai.id = e.advice_item_id
                            join public.advisory_plan_items pi on pi.id = ai.plan_item_id where pi.plan_id = p.id and e.status in ('EXECUTED', 'PARTIAL')))::text
            from public.advisory_plans p where p.id = s.active_plan_id) as plan_start,
           l.snapshot_date::text as cas_date, l.snapshot_id, app.today_ist()::text as today
    from public.v_client_summary s left join public.v_latest_snapshot l on l.client_id = s.client_id
    where s.client_id = ${clientId}`;
  if (!c) throw new AppError("Client not found or you do not have access.", "NOT_FOUND");
  if (!c.cas_date || !c.snapshot_id) throw new AppError("This client has no confirmed CAS yet: confirm one before a quarterly review.");
  return { client: { id: c.id, name: c.name, code: c.code }, onboarding: c.onboarding, activePlanId: c.plan_id, planName: c.plan_name, planStart: c.plan_start, casDate: c.cas_date, snapshotId: c.snapshot_id, today: c.today };
}

/** Start of the review window: the day after the last downloaded review's period end, else the plan's start, else onboarding. */
async function windowStartOf(tx: Tx, clientId: string, quarterEnd: string, b: Basics, firstTxn: string | null): Promise<string> {
  const [prev] = await tx<{ as_of: string }[]>`
    select max(f.as_of)::text as as_of from public.quarterly_review_files f join public.quarterly_reviews r on r.id = f.review_id
    where f.client_id = ${clientId} and r.quarter_end < ${quarterEnd}`;
  return prev?.as_of ? addDaysIso(prev.as_of, 1) : b.planStart ?? b.onboarding ?? firstTxn ?? b.casDate;
}

/** Amount of an execution (`e`, security `m`): its amount, else units × its price, else units × today's NAV. */
const execAmount = (tx: Tx) => tx`coalesce(nullif(e.executed_amount, 0), e.executed_units * e.execution_price, e.executed_units * m.nav, 0)`;

/** An execution `e` confirmed by the client or advisor that the CAS figures do not include (v_client_bank, 0048). */
function approvedSql(tx: Tx, clientId: string) {
  return tx`(e.cas_verified_at is null and e.verification_type in ('CLIENT_CONFIRMED', 'ADVISOR_CONFIRMED')
    and not coalesce((select e.execution_date < l.snapshot_date and e.created_at >= coalesce(ps.reviewed_at, ps.created_at)
                      from public.v_latest_snapshot l join public.portfolio_snapshots ps on ps.id = l.snapshot_id
                      where l.client_id = ${clientId}), false))`;
}

const KEY = (securityId: string | null, name: string) => securityId ?? `name:${name.trim().toLowerCase()}`;

/** Codes whose past NAVs the review needs, and from when (call ensureNavHistory with them first). */
export async function navNeeds(tx: Tx, clientId: string, quarterEnd: string): Promise<{ codes: string[]; from: string; to: string }> {
  const b = await basics(tx, clientId);
  const codes = await tx<{ code: string }[]>`
    select distinct coalesce(m.amfi_code, sm.amfi_code) as code
    from (select h.security_id, h.isin from public.v_holding_live h where h.client_id = ${clientId}
          union select t.security_id, t.isin from public.v_cas_transactions t where t.client_id = ${clientId}) x
    left join public.security_master sm on sm.id = x.security_id
    left join public.mf_schemes m on m.isin = coalesce(x.isin, sm.isin)
    where coalesce(m.amfi_code, sm.amfi_code) is not null`;
  const bench = await listBenchmarks(tx);
  const [first] = await tx<{ d: string | null }[]>`select min(transaction_date)::text as d from public.v_cas_transactions where client_id = ${clientId}`;
  const start = await windowStartOf(tx, clientId, quarterEnd, b, first?.d ?? null);
  return { codes: [...codes.map((c) => c.code), ...bench.map((x) => x.amfi)], from: addDaysIso(start, -10), to: b.today };
}

export async function gatherReview(tx: Tx, clientId: string, quarterEnd: string, extra: { otherClientNames: string[]; navFailed: string[] }): Promise<RawReview> {
  assertQuarter(quarterEnd);
  const b = await basics(tx, clientId);

  const funds = await tx<(RawFund & { nav_date: string | null })[]>`
    select coalesce(h.security_id::text, 'name:' || lower(trim(h.scheme_name))) as key,
           max(coalesce(h.isin, sm.isin)) as isin, max(coalesce(m.amfi_code, sm.amfi_code)) as amfi,
           max(coalesce(sm.scheme_name, h.scheme_name)) as name, max(coalesce(m.category, sm.category)) as category, max(coalesce(m.amc, sm.amc)) as amc,
           sum(h.units)::float8 as units, sum(h.live_value)::float8 as value, (case when bool_and(h.cost_value is not null) then sum(h.cost_value) end)::float8 as cost,
           sum(coalesce(h.cas_value, 0))::float8 as "casValue", max(h.nav)::float8 as nav, max(h.nav_date)::text as nav_date
    from public.v_holding_live h
    left join public.security_master sm on sm.id = h.security_id
    left join public.mf_schemes m on m.isin = coalesce(h.isin, sm.isin)
    where h.client_id = ${clientId} and h.units > 0
    group by 1`;
  const asOf = funds.map((f) => f.nav_date).filter((d): d is string => !!d).sort().pop() ?? b.today;

  // Direction from the units' sign: a bounced / reversed instalment (negative units on a purchase, or an
  // "OTHER" row taking units out) cancels that buy; a reversed redemption cancels that sale.
  const txRows = await tx<{ security_id: string | null; name: string; date: string; et: string; side: "BUY" | "SELL"; units: number | null; amount: number }[]>`
    select t.security_id, coalesce(sm.scheme_name, t.scheme_name) as name, t.transaction_date::text as date, t.effective_type as et, x.side,
           (abs(t.units) * x.dir)::float8 as units, (abs(t.amount) * x.dir)::float8 as amount
    from public.v_cas_transactions t
    left join public.security_master sm on sm.id = t.security_id
    cross join lateral (
      select case when t.effective_type in ('REDEMPTION', 'SWITCH_OUT') then 'SELL' else 'BUY' end as side,
             case when t.effective_type in ('REDEMPTION', 'SWITCH_OUT') then (case when t.units > 0 then -1 else 1 end)
                  when t.units < 0 or (t.units is null and t.amount < 0) then -1 else 1 end as dir) x
    where t.client_id = ${clientId} and coalesce(t.amount, 0) <> 0
      and (t.effective_type in ('PURCHASE', 'SIP', 'SWITCH_IN', 'REDEMPTION', 'SWITCH_OUT', 'DIVIDEND_REINVESTMENT')
           or (t.effective_type = 'OTHER' and t.units < 0))
    order by t.transaction_date, x.dir desc`;
  const txns: RawTxn[] = txRows.map((t) => ({
    key: KEY(t.security_id, t.name), name: t.name, date: t.date, side: t.side, units: t.units, amount: t.amount,
    ...(t.amount < 0 ? { reversal: true } : {}), ...(t.et === "DIVIDEND_REINVESTMENT" ? { reinvest: true } : {}),
  }));
  // Trades confirmed by the client or advisor that no CAS shows yet: the v_client_bank rule (migration 0048).
  // A trade dated after the latest CAS, or one approved before that CAS was confirmed that it still does not show.
  // A trade placed by units with no amount is valued at its price, else today's NAV.
  const approved = await tx<{ security_id: string; name: string; date: string; action: string; amount: number; units: number | null }[]>`
    select e.security_id, sm.scheme_name as name, e.execution_date::text as date, ai.action,
           ${execAmount(tx)}::float8 as amount, e.executed_units::float8 as units
    from public.executions e join public.advice_items ai on ai.id = e.advice_item_id join public.security_master sm on sm.id = e.security_id
    left join public.mf_schemes m on m.isin = sm.isin
    where e.client_id = ${clientId} and e.status in ('EXECUTED', 'PARTIAL') and ${approvedSql(tx, clientId)}`;
  for (const a of approved) txns.push({ key: a.security_id, name: a.name, date: a.date, side: a.action === "BUY" ? "BUY" : "SELL", units: a.units, amount: a.amount, approved: true });
  txns.sort((x, y) => x.date.localeCompare(y.date));
  const firstTxn = txns[0]?.date ?? null;
  const windowStart = await windowStartOf(tx, clientId, quarterEnd, b, firstTxn);

  const held = new Set(funds.map((f) => f.key));
  const soldKeys = [...new Set(txns.filter((t) => !held.has(t.key)).map((t) => t.key))].filter((k) => !k.startsWith("name:"));
  const sold = soldKeys.length ? await tx<RawSoldFund[]>`
    select sm.id::text as key, sm.scheme_name as name, coalesce(m.category, sm.category) as category, coalesce(m.amfi_code, sm.amfi_code) as amfi, m.nav::float8 as nav
    from public.security_master sm left join public.mf_schemes m on m.isin = sm.isin
    where sm.id = any(${soldKeys}::uuid[])` : [];

  const planLines = b.activePlanId ? await tx<RawPlanLine[]>`
    select v.security_id::text as key, v.scheme_name as name, v.side, v.target_amount::float8 as planned,
           coalesce(x.done_cas, 0)::float8 as "doneCas", coalesce(x.approved, 0)::float8 as approved,
           -- A line the plan calls complete has nothing left to do (a unit-based exit can land a little short).
           (case when v.progress_status = 'COMPLETED' then 0
                 else coalesce(v.yet_to_advise_amount, 0) + coalesce(v.pending_amount, 0) end)::float8 as left,
           v.progress_status = 'COMPLETED' as completed, v.reason,
           (v.last_advised_at at time zone 'Asia/Kolkata')::date::text as "advisedOn", x.last_done::text as "doneOn"
    from public.v_plan_item_progress v
    left join lateral (
      select sum(${execAmount(tx)}) filter (where not ${approvedSql(tx, clientId)}) as done_cas,
             sum(${execAmount(tx)}) filter (where ${approvedSql(tx, clientId)}) as approved,
             max(e.execution_date) as last_done
      from public.executions e join public.advice_items ai on ai.id = e.advice_item_id
      left join public.security_master sm on sm.id = e.security_id left join public.mf_schemes m on m.isin = sm.isin
      where ai.plan_item_id = v.plan_item_id and e.status in ('EXECUTED', 'PARTIAL')) x on true
    where v.plan_id = ${b.activePlanId} and v.side in ('SELL', 'BUY') and v.item_status <> 'CANCELLED' and v.target_amount > 0.5
    order by v.side desc, v.target_amount desc` : [];

  const sips = b.activePlanId ? await tx<RawSip[]>`
    select s.id, coalesce(s.security_id::text, 'name:' || lower(trim(s.scheme_name))) as key, coalesce(sm.scheme_name, s.scheme_name) as name,
           coalesce(m.category, sm.category) as category, s.action, coalesce(s.old_amount, 0)::float8 as "oldAmount",
           coalesce(s.new_amount, 0)::float8 as "newAmount", s.status, s.notes
    from public.sip_plan_items s left join public.security_master sm on sm.id = s.security_id left join public.mf_schemes m on m.isin = sm.isin
    where s.client_id = ${clientId} and s.plan_id = ${b.activePlanId}
    order by s.new_amount desc nulls last` : [];

  const ownTrades = await tx<RawReview["ownTrades"]>`
    select m.transaction_date::text as date, m.scheme_name as name, m.approx_amount::float8 as amount,
           (case when m.change_type = 'DECREASE' then 'SELL' else 'BUY' end) as side
    from public.reconciliation_matches m join public.reconciliation_runs r on r.id = m.run_id
    where m.client_id = ${clientId} and r.status <> 'CANCELLED' and m.classification = 'UNADVISED'
      and m.reviewed_at is not null and not (m.status = 'REJECTED' and coalesce(m.resolution_note, '') like 'Recorded as advised%')
      and not (m.status = 'REJECTED' and coalesce(m.resolution_note, '') like 'History:%')
      and m.transaction_date >= ${windowStart}::date and coalesce(m.approx_amount, 0) > 0
    order by m.transaction_date`;

  const baseline = await tx<MixRow[]>`
    select coalesce(sm.scheme_name, h.scheme_name) as name, coalesce(m.category, sm.category, h.category) as category,
           coalesce(m.amc, sm.amc, h.amc) as amc, h.current_value::float8 as value
    from public.portfolio_holdings h
    left join public.security_master sm on sm.id = h.security_id
    left join public.mf_schemes m on m.isin = coalesce(h.isin, sm.isin)
    where h.snapshot_id = (select p.id from public.portfolio_snapshots p where p.client_id = ${clientId} and p.review_status = 'CONFIRMED'
                           and not p.is_correction order by p.is_baseline desc, p.snapshot_date limit 1)
      and coalesce(h.current_value, 0) > 0`;

  const [sipM] = await tx<{ v: number }[]>`
    select coalesce(sum(i.amount), 0)::float8 / 3 as v from public.v_sip_instalments i
    where i.client_id = ${clientId} and i.transaction_date > ${b.casDate}::date - 91 and i.transaction_date <= ${b.casDate}::date`;

  const benchmarks = await listBenchmarks(tx);
  // Overrides by ISIN, for every fund in the review (held, sold, or bought after the CAS).
  const ids = [...new Set([...funds.map((f) => f.key), ...txns.map((t) => t.key)])].filter((k) => !k.startsWith("name:"));
  const overrides = ids.length ? await tx<{ key: string; index_code: string | null }[]>`
    select sm.id::text as key, fb.index_code from public.fund_benchmarks fb join public.security_master sm on sm.isin = fb.isin
    where sm.id = any(${ids}::uuid[])` : [];
  const fundIndex: Record<string, string | null> = Object.fromEntries(overrides.map((o) => [o.key, o.index_code]));

  const [mk] = await tx<{ data: unknown }[]>`select data from public.market_context where quarter_end = ${quarterEnd}`;
  const [no] = await tx<{ n: number }[]>`
    select count(distinct r.quarter_end)::int as n from public.quarterly_reviews r
    where r.client_id = ${clientId} and r.quarter_end < ${quarterEnd} and exists (select 1 from public.quarterly_review_files f where f.review_id = r.id)`;

  const codes = [...funds.map((f) => f.amfi), ...sold.map((s) => s.amfi), ...benchmarks.map((x) => x.amfi)].filter((c): c is string => !!c);
  const navs = await navSeries(tx, codes, addDaysIso(windowStart, -10), b.today);

  return {
    client: b.client, quarterEnd, today: b.today, asOf, casDate: b.casDate, windowStart, reviewNo: (no?.n ?? 0) + 1, planName: b.planName,
    funds: funds.map(({ nav_date: _d, ...f }) => f), sold, txns, planLines,
    planDeltas: (await getClientMix(tx, clientId)).planDeltas, sips, ownTrades, baseline, sipMonthly: sipM?.v ?? 0,
    navs, benchmarks, fundIndex, otherClientNames: extra.otherClientNames, market: readMarket(mk?.data), navFailed: extra.navFailed,
  };
}

/** Every other client's name, for the check that no other client is named in the PDF (run as the server: advisors see only their own clients). */
export async function otherClientNames(tx: Tx, clientId: string): Promise<string[]> {
  return (await tx<{ full_name: string }[]>`select full_name from public.clients where id <> ${clientId} and deleted_at is null`).map((r) => r.full_name);
}

export async function recordReviewFile(tx: Tx, actor: Actor, f: { clientId: string; quarterEnd: string; filePath: string; fileName: string; size: number; sha256: string; asOf: string }): Promise<string> {
  const [r] = await tx<{ id: string }[]>`
    insert into public.quarterly_reviews (client_id, quarter_end, created_by, updated_by) values (${f.clientId}, ${f.quarterEnd}, ${actor.id}, ${actor.id})
    on conflict (client_id, quarter_end) do update set updated_by = public.quarterly_reviews.updated_by
    returning id`;
  const [file] = await tx<{ id: string }[]>`
    insert into public.quarterly_review_files (review_id, client_id, file_path, file_name, size_bytes, sha256, as_of, created_by)
    values (${r.id}, ${f.clientId}, ${f.filePath}, ${f.fileName}, ${f.size}, ${f.sha256}, ${f.asOf}, ${actor.id}) returning id`;
  return file.id;
}

export async function getReviewFile(tx: Tx, fileId: string): Promise<{ file_path: string; file_name: string; client_id: string }> {
  const [f] = await tx<{ file_path: string; file_name: string; client_id: string }[]>`
    select file_path, file_name, client_id from public.quarterly_review_files where id = ${fileId}`;
  if (!f) throw new AppError("File not found or you do not have access.", "NOT_FOUND");
  return f;
}

/** Downloads per quarter for the Reports tile. */
export async function listReviewFiles(tx: Tx, clientId: string): Promise<{ quarter_end: string; files: number; last: Date }[]> {
  return tx`
    select r.quarter_end::text, count(f.id)::int as files, max(f.created_at) as last
    from public.quarterly_reviews r join public.quarterly_review_files f on f.review_id = r.id
    where r.client_id = ${clientId} group by r.quarter_end order by r.quarter_end desc`;
}
