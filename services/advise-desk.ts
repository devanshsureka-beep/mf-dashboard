/**
 * Calls & tranches → Find clients: which clients to advise today.
 *
 * Every number here comes from the existing views (v_client_summary through
 * listDeskClients, v_plan_item_progress, v_advice_items, v_holding_live,
 * v_client_bank); nothing is computed that those views already define.
 */
import type { Tx } from "@/lib/db/tx";
import { listDeskClients } from "@/services/clients";
import type { RiskProfile } from "@/types/domain";

export type ReadyList = "cash" | "buys" | "sells" | "quiet" | "all";

export interface DeskFilter {
  list?: ReadyList;
  advisorId?: string | null;
  risk?: RiskProfile | null;
  /** Cash in bank at least this many rupees. */
  cashMin?: number | null;
  left?: "buy" | "sell" | "none" | null;
  /** Last tranche: over 7 / 30 days ago, or never. */
  last?: "7" | "30" | "never" | null;
  /** Leave out clients with calls still waiting for the CAS. */
  hideWaiting?: boolean;
}

export interface NextLine { action: string; scheme_name: string; amount: number }

export interface DeskRow {
  client_id: string;
  full_name: string;
  client_code: string;
  risk_profile: RiskProfile | null;
  advisor_name: string | null;
  value: number;
  in_bank: number;
  sell_left: number;
  buy_left: number;
  has_plan: boolean;
  pending_total: number;
  open_calls: number;
  /** ISO timestamp of the last tranche, and how many IST days ago it was. */
  last_tranche_at: string | null;
  last_tranche_days: number | null;
  last_tranche_code: string | null;
  last_tranche_calls: number;
  /** The plan lines still to advise, biggest first (at most three). */
  next: NextLine[];
  next_more: number;
}

export interface ReadyCounts { cash: { clients: number; amount: number }; buys: { clients: number; amount: number }; sells: { clients: number; amount: number }; quiet: { clients: number; never: number }; all: number }


/** Every active client the user can see, with what the desk needs to pick who to call. */
export async function listDeskRows(tx: Tx, f: Pick<DeskFilter, "advisorId" | "risk"> = {}): Promise<DeskRow[]> {
  const clients = await listDeskClients(tx, { status: "ACTIVE", advisorId: f.advisorId ?? undefined, risk: f.risk ?? undefined });
  if (!clients.length) return [];
  const ids = clients.map((c) => c.client_id);
  const tranches = await tx<{ client_id: string; at: string; days: number; code: string; calls: number }[]>`
    select distinct on (b.client_id) b.client_id, to_char(b.communicated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as at,
           (app.today_ist() - (b.communicated_at at time zone 'Asia/Kolkata')::date)::int as days, b.batch_code as code,
           (select count(*)::int from public.advice_items i where i.advice_batch_id = b.id) as calls
    from public.advice_batches b
    where b.client_id = any(${ids}::uuid[]) and b.status = 'ACTIVE'
    order by b.client_id, b.communicated_at desc`;
  const lines = await tx<{ client_id: string; action: string; scheme_name: string; amount: number }[]>`
    select v.client_id, v.action, v.scheme_name, v.yet_to_advise_amount::float8 as amount
    from public.v_plan_item_progress v
    where v.client_id = any(${ids}::uuid[]) and v.plan_status = 'ACTIVE' and v.item_status = 'OPEN'
      and v.side <> 'NONE' and v.yet_to_advise_amount >= 0.5
    order by v.client_id, v.yet_to_advise_amount desc`;
  const tr = new Map(tranches.map((t) => [t.client_id, t]));
  const next = new Map<string, NextLine[]>();
  for (const l of lines) next.set(l.client_id, [...(next.get(l.client_id) ?? []), { action: l.action, scheme_name: l.scheme_name, amount: l.amount }]);
  return clients.map((c) => {
    const t = tr.get(c.client_id);
    const n = next.get(c.client_id) ?? [];
    return {
      client_id: c.client_id, full_name: c.full_name, client_code: c.client_code, risk_profile: c.risk_profile, advisor_name: c.advisor_name,
      value: Number(c.live_portfolio_value ?? 0), in_bank: Number(c.in_bank ?? 0),
      sell_left: Number(c.yet_to_advise_sell ?? 0), buy_left: Number(c.yet_to_advise_buy ?? 0),
      has_plan: Boolean(c.active_plan_id), pending_total: Number(c.pending_total ?? 0), open_calls: Number(c.open_calls ?? 0),
      last_tranche_at: t?.at ?? null, last_tranche_days: t?.days ?? null, last_tranche_code: t?.code ?? null, last_tranche_calls: t?.calls ?? 0,
      next: n.slice(0, 3), next_more: Math.max(0, n.length - 3),
    };
  });
}

const isQuiet = (r: DeskRow) => r.has_plan && (r.last_tranche_days == null || r.last_tranche_days > 30);

export function readyCounts(rows: DeskRow[]): ReadyCounts {
  const pick = (fn: (r: DeskRow) => number) => {
    const hit = rows.filter((r) => fn(r) >= 0.5);
    return { clients: hit.length, amount: hit.reduce((t, r) => t + fn(r), 0) };
  };
  const quiet = rows.filter(isQuiet);
  return {
    cash: pick((r) => r.in_bank), buys: pick((r) => r.buy_left), sells: pick((r) => r.sell_left),
    quiet: { clients: quiet.length, never: quiet.filter((r) => !r.last_tranche_at).length }, all: rows.length,
  };
}

/** The rows a ready list and the filters leave, in the order that list reads best. */
export function filterDeskRows(rows: DeskRow[], f: DeskFilter): DeskRow[] {
  const list = f.list ?? "cash";
  let out = rows.filter((r) => (list === "cash" ? r.in_bank >= 0.5 : list === "buys" ? r.buy_left >= 0.5 : list === "sells" ? r.sell_left >= 0.5 : list === "quiet" ? isQuiet(r) : true));
  if (f.cashMin != null) out = out.filter((r) => r.in_bank >= f.cashMin!);
  if (f.left === "buy") out = out.filter((r) => r.buy_left >= 0.5);
  if (f.left === "sell") out = out.filter((r) => r.sell_left >= 0.5);
  if (f.left === "none") out = out.filter((r) => r.buy_left < 0.5 && r.sell_left < 0.5);
  if (f.last === "never") out = out.filter((r) => !r.last_tranche_at);
  if (f.last === "7" || f.last === "30") out = out.filter((r) => r.last_tranche_days == null || r.last_tranche_days > Number(f.last));
  if (f.hideWaiting) out = out.filter((r) => r.pending_total < 0.5);
  const by: Record<ReadyList, (a: DeskRow, b: DeskRow) => number> = {
    cash: (a, b) => b.in_bank - a.in_bank,
    buys: (a, b) => b.buy_left - a.buy_left,
    sells: (a, b) => b.sell_left - a.sell_left,
    quiet: (a, b) => (a.last_tranche_at ?? "").localeCompare(b.last_tranche_at ?? ""),
    all: (a, b) => a.full_name.localeCompare(b.full_name),
  };
  return out.sort(by[list]);
}

// ---------------------------------------------------------------------------
// A fund: who holds it, whose plan has it, advised or not
// ---------------------------------------------------------------------------
export interface FundMatch { security_id: string; scheme_name: string; isin: string | null; holders: number; held_value: number; in_plans: number }

/**
 * The same fund can sit under several security records (a report line saved
 * without an ISIN, a name variant): records whose names match once "plan",
 * "option", "fund", "growth" and punctuation are dropped count as one fund.
 * Direct and Regular stay apart (the words are in the names).
 */
const FUND_KEY = (col: string) => `regexp_replace(lower(${col}), '\\m(plan|option|fund|growth)\\M|non[^a-z]*demat|[^a-z0-9]', '', 'g')`;

/** Every security record of the fund `securityId` belongs to. */
export async function fundFamily(tx: Tx, securityId: string): Promise<string[]> {
  const rows = await tx<{ id: string }[]>`
    select f.id from public.security_master f, public.security_master s
    where s.id = ${securityId} and ${tx.unsafe(FUND_KEY("f.scheme_name"))} = ${tx.unsafe(FUND_KEY("s.scheme_name"))}
      -- Two different ISINs (or Growth vs IDCW) are two securities, whatever the names say.
      and (f.isin is null or s.isin is null or f.isin = s.isin)
      and (f.option_type is null or s.option_type is null or f.option_type = s.option_type)`;
  return rows.length ? rows.map((r) => r.id) : [securityId];
}

/** Funds matching the words (or ISIN) that a client holds or an active plan has; most-held first. */
export async function fundsMatching(tx: Tx, q: string, limit = 12): Promise<FundMatch[]> {
  const words = q.trim().split(/\s+/).filter(Boolean).slice(0, 6);
  if (!words.length) return [];
  const isin = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/i.test(q.trim()) ? q.trim().toUpperCase() : null;
  const like = words.map((w) => `%${w.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
  return tx<FundMatch[]>`
    with hit as (
      select distinct ${tx.unsafe(FUND_KEY("sm.scheme_name"))} as key from public.security_master sm
      where (${isin}::text is not null and sm.isin = ${isin})
         or (${isin}::text is null and sm.scheme_name ilike all(${like}::text[]))
    ), rec as (
      select hit.key, sm.id, sm.scheme_name, sm.isin from hit
      join public.security_master sm on ${tx.unsafe(FUND_KEY("sm.scheme_name"))} = hit.key
    ), fam as (
      -- One group per ISIN; a record without one joins the ISIN of its name when there is exactly one.
      select r.*, r.key || ':' || coalesce(r.isin,
               (select case when count(distinct x.isin) = 1 then max(x.isin) end from rec x where x.key = r.key and x.isin is not null), '') as grp
      from rec r
    ), held as (
      select fam.grp, count(distinct h.client_id)::int as holders, coalesce(sum(h.live_value), 0)::float8 as held_value
      from fam join public.v_holding_live h on h.security_id = fam.id and h.units > 0.0005
      join public.clients c on c.id = h.client_id and c.deleted_at is null and c.status = 'ACTIVE' group by fam.grp
    ), planned as (
      select fam.grp, count(distinct v.client_id)::int as in_plans
      from fam join public.v_plan_item_progress v on v.security_id = fam.id and v.plan_status = 'ACTIVE' and v.item_status <> 'CANCELLED'
      join public.clients c on c.id = v.client_id and c.deleted_at is null and c.status = 'ACTIVE'
      group by fam.grp
    ), one as (
      select distinct on (fam.grp)
             fam.id as security_id, fam.scheme_name, fam.isin,
             coalesce(held.holders, 0) as holders, coalesce(held.held_value, 0) as held_value, coalesce(planned.in_plans, 0) as in_plans
      from fam left join held on held.grp = fam.grp left join planned on planned.grp = fam.grp
      where coalesce(held.holders, 0) > 0 or coalesce(planned.in_plans, 0) > 0
      -- The record shown: the one with an ISIN that clients hold most.
      order by fam.grp, (fam.isin is null), (select count(*) from public.v_holding_live h where h.security_id = fam.id) desc
    )
    select * from one order by holders desc, in_plans desc, scheme_name limit ${limit}`;
}

export type FundAdvised = "WAITING" | "PART_DONE" | "NOT_ADVISED" | "DONE" | "NO_CALL" | "NOT_IN_PLAN";

export interface FundAudienceRow {
  row: DeskRow;
  holding: { value: number; units: number; folios: number; plan_types: string | null } | null;
  /** The client's active-plan line for this fund (the one with most left to advise). */
  plan: { plan_item_id: string; action: string; side: "BUY" | "SELL" | "NONE"; target: number; left: number; executed: number; full_exit: boolean } | null;
  advised: FundAdvised;
  open: { since: string; since_days: number; advised: number; executed: number; calls: number } | null;
  done_on: string | null;
}

export interface FundView {
  security_id: string;
  scheme_name: string;
  isin: string | null;
  category: string | null;
  nav: number | null;
  nav_date: string | null;
  rows: FundAudienceRow[];
}

export async function fundAudience(tx: Tx, securityId: string, f: Pick<DeskFilter, "advisorId" | "risk"> = {}): Promise<FundView | null> {
  const sec = (await tx<{ scheme_name: string; isin: string | null; category: string | null }[]>`
    select scheme_name, isin, category from public.security_master where id = ${securityId}`)[0];
  if (!sec) return null;
  const ids = await fundFamily(tx, securityId);
  const nav = (await tx<{ nav: number | null; nav_date: string | null }[]>`
    select nav::float8 as nav, nav_date::text as nav_date from public.v_holding_live
    where security_id = any(${ids}::uuid[]) and nav is not null order by nav_date desc nulls last limit 1`)[0];
  const holdings = await tx<{ client_id: string; value: number; units: number; folios: number; plan_types: string | null }[]>`
    select client_id, sum(live_value)::float8 as value, sum(units)::float8 as units, count(distinct folio_number)::int as folios,
           string_agg(distinct plan_type, ' / ') as plan_types
    from public.v_holding_live where security_id = any(${ids}::uuid[]) and units > 0.0005 group by client_id`;
  const items = await tx<{ client_id: string; plan_item_id: string; action: string; side: "BUY" | "SELL" | "NONE"; target: number; left: number; executed: number; current_amount: number | null }[]>`
    select distinct on (v.client_id) v.client_id, v.plan_item_id, v.action, v.side, v.target_amount::float8 as target,
           v.yet_to_advise_amount::float8 as "left", v.executed_amount::float8 as executed, v.current_amount::float8 as current_amount
    from public.v_plan_item_progress v
    where v.security_id = any(${ids}::uuid[]) and v.plan_status = 'ACTIVE' and v.item_status <> 'CANCELLED'
    order by v.client_id, (v.side <> 'NONE') desc, v.yet_to_advise_amount desc`;
  const open = await tx<{ client_id: string; since: string; since_days: number; advised: number; executed: number; calls: number }[]>`
    select client_id, to_char(min(communicated_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as since,
           (app.today_ist() - (min(communicated_at) at time zone 'Asia/Kolkata')::date)::int as since_days, sum(advised_amount)::float8 as advised,
           sum(executed_amount)::float8 as executed, count(*)::int as calls
    from public.v_advice_items where security_id = any(${ids}::uuid[]) and is_open group by client_id`;
  const done = await tx<{ client_id: string; done_on: string }[]>`
    select e.client_id, max(e.execution_date)::text as done_on from public.executions e
    where e.security_id = any(${ids}::uuid[]) and e.status in ('EXECUTED', 'PARTIAL') group by e.client_id`;
  const H = new Map(holdings.map((h) => [h.client_id, h]));
  const I = new Map(items.map((i) => [i.client_id, i]));
  const O = new Map(open.map((o) => [o.client_id, o]));
  const D = new Map(done.map((d) => [d.client_id, d.done_on]));
  const audience = new Set([...H.keys(), ...I.keys(), ...O.keys()]);
  const desk = (await listDeskRows(tx, f)).filter((r) => audience.has(r.client_id));
  const rows: FundAudienceRow[] = desk.map((r) => {
    const h = H.get(r.client_id) ?? null;
    const i = I.get(r.client_id) ?? null;
    const o = O.get(r.client_id) ?? null;
    const plan = i ? {
      plan_item_id: i.plan_item_id, action: i.action, side: i.side, target: i.target, left: i.left, executed: i.executed,
      // Selling (about) all of what the client holds.
      full_exit: i.side === "SELL" && h != null && h.value > 0 && i.target >= h.value * 0.95,
    } : null;
    // Plan money still to advise comes first, even when part of the line was told already.
    const advised: FundAdvised = plan && plan.side !== "NONE" && plan.left >= 0.5 ? "NOT_ADVISED"
      : o ? (o.executed >= 0.5 ? "PART_DONE" : "WAITING")
      : plan && plan.side !== "NONE" ? "DONE"
      : plan ? "NO_CALL" : "NOT_IN_PLAN";
    return { row: r, holding: h ? { value: h.value, units: h.units, folios: h.folios, plan_types: h.plan_types } : null, plan, advised, open: o, done_on: D.get(r.client_id) ?? null };
  });
  // Calls to give first, then what is under way, then the rest; biggest first.
  const rank: Record<FundAdvised, number> = { NOT_ADVISED: 0, WAITING: 1, PART_DONE: 2, DONE: 3, NO_CALL: 4, NOT_IN_PLAN: 5 };
  rows.sort((a, b) => rank[a.advised] - rank[b.advised] || (b.plan?.left ?? 0) - (a.plan?.left ?? 0) || (b.holding?.value ?? 0) - (a.holding?.value ?? 0));
  return { security_id: securityId, scheme_name: sec.scheme_name, isin: sec.isin, category: sec.category, nav: nav?.nav ?? null, nav_date: nav?.nav_date ?? null, rows };
}
