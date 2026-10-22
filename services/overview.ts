/**
 * Overview: the manager's view of the book — what was advised and executed, what is still to
 * happen, money idle in bank, the SIP gap, monthly activity, the client book and every trade with
 * its proof. Plan numbers come from v_client_summary, money from v_client_bank (listDeskClients),
 * so they match every other screen.
 */
import type { Tx } from "@/lib/db/tx";
import { clientStatus, nextAction, proofOf, type BookStatus, type Proof } from "@/lib/domain/overview";
import { primaryAdvisor } from "./book";
import { listDeskClients } from "./clients";
import { listWaiting } from "./waiting";

export interface OverviewFilter {
  advisorId: string | null;
  from: string;
  to: string;
}

export interface OverviewKpis {
  clients: number;
  onPlan: number;
  agreementsSigned: number;
  /** executed = every trade done (any call); planExecuted = the part on the active plans (for % of advised). */
  sell: { target: number; executed: number; planExecuted: number; waiting: number; notAdvised: number };
  buy: { target: number; executed: number; planExecuted: number; waiting: number; notAdvised: number };
  idle: { amount: number; clients: number };
  sip: { target: number; running: number };
}

export interface MonthRow {
  month: string; // YYYY-MM
  reports: number;
  cas_checks: number;
  agreements: number;
  sell_clients: number;
  sell: number;
  buy_clients: number;
  buy: number;
}

export interface BookRow {
  client_id: string;
  name: string;
  code: string;
  advisor: string | null;
  status: BookStatus;
  sold: number;
  sell_pending: number;
  bought: number;
  buy_pending: number;
  idle: number;
  sip_gap: number;
  next: string;
}

export interface TxnRow {
  date: string;
  client_id: string;
  client: string;
  side: "SELL" | "BUY";
  fund: string;
  amount: number;
  proof: Proof;
  call: string | null;
}

export interface Overview {
  kpis: OverviewKpis;
  months: MonthRow[];
  book: BookRow[];
  txns: TxnRow[];
}

export async function getOverview(tx: Tx, f: OverviewFilter): Promise<Overview> {
  const adv = f.advisorId;
  const clients = await listDeskClients(tx, adv ? { advisorId: adv } : {});
  const ids = clients.map((c) => c.client_id);

  const sips = await tx<{ client_id: string; target: number; running: number }[]>`
    select client_id, coalesce(sip_monthly_target, 0)::float8 as target, coalesce(sip_monthly_started, 0)::float8 as running
    from public.v_client_sip where client_id = any(${ids}::uuid[])`;
  const sipOf = new Map(sips.map((s) => [s.client_id, s]));
  const agreements = await tx<{ client_id: string }[]>`
    select distinct client_id from public.client_agreements
    where client_id = any(${ids}::uuid[]) and status = 'SIGNED' and (valid_to is null or valid_to >= app.today_ist())`;
  const signed = new Set(agreements.map((a) => a.client_id));

  // Oldest waiting call per client (and whether a CAS came after it).
  const waiting = await listWaiting(tx, { advisorId: adv });
  const oldest = new Map<string, { days: number; casAfter: boolean }>();
  for (const w of waiting) {
    const o = oldest.get(w.client_id);
    if (!o || w.age_days > o.days) oldest.set(w.client_id, { days: w.age_days, casAfter: Boolean(w.cas_after) });
  }

  // Every trade done per client (any call: plan lines, calls outside the plan, clients without an active plan).
  // Like the plan views, every call that is not a buy (sell, switch, move to Direct) counts on the sell side.
  const done = await tx<{ client_id: string; sold: number; bought: number }[]>`
    select e.client_id,
           coalesce(sum(e.executed_amount) filter (where ai.action <> 'BUY'), 0)::float8 as sold,
           coalesce(sum(e.executed_amount) filter (where ai.action = 'BUY'), 0)::float8 as bought
    from public.executions e join public.advice_items ai on ai.id = e.advice_item_id
    where e.client_id = any(${ids}::uuid[]) and e.status in ('EXECUTED', 'PARTIAL')
    group by e.client_id`;
  const doneOf = new Map(done.map((d) => [d.client_id, d]));
  const n = (v: unknown) => Number(v ?? 0);
  const sum = (fn: (c: (typeof clients)[number]) => number) => clients.reduce((t, c) => t + fn(c), 0);
  // Waiting = every call advised and not done yet (plan lines and calls outside the plan), as on Today.
  const waitingBy = (side: "SELL" | "BUY") => waiting.filter((w) => (side === "BUY" ? w.action === "BUY" : w.action !== "BUY")).reduce((t, w) => t + Number(w.pending_amount), 0);
  const waitOf = (id: string, side: "SELL" | "BUY") => waiting.filter((w) => w.client_id === id && (side === "BUY" ? w.action === "BUY" : w.action !== "BUY")).reduce((t, w) => t + Number(w.pending_amount), 0);
  const kpis: OverviewKpis = {
    clients: clients.length,
    onPlan: clients.filter((c) => c.active_plan_id).length,
    agreementsSigned: clients.filter((c) => signed.has(c.client_id)).length,
    sell: { target: sum((c) => n(c.target_sell)), executed: done.reduce((t, d) => t + d.sold, 0), planExecuted: sum((c) => n(c.executed_sell)), waiting: waitingBy("SELL"), notAdvised: sum((c) => n(c.yet_to_advise_sell)) },
    buy: { target: sum((c) => n(c.target_buy)), executed: done.reduce((t, d) => t + d.bought, 0), planExecuted: sum((c) => n(c.executed_buy)), waiting: waitingBy("BUY"), notAdvised: sum((c) => n(c.yet_to_advise_buy)) },
    idle: { amount: sum((c) => n(c.in_bank)), clients: clients.filter((c) => n(c.in_bank) >= 0.5).length },
    sip: { target: sips.reduce((t, s) => t + s.target, 0), running: sips.reduce((t, s) => t + Math.min(s.running, s.target), 0) },
  };

  const book: BookRow[] = clients.map((c) => {
    const o = oldest.get(c.client_id);
    const facts = {
      has_plan: Boolean(c.active_plan_id), has_draft: Boolean(c.has_draft_plan), draft_days: c.draft_days ?? null,
      // Every call waiting (on the plan or not), as on Today.
      pending: waitOf(c.client_id, "SELL") + waitOf(c.client_id, "BUY"),
      executed: (doneOf.get(c.client_id)?.sold ?? 0) + (doneOf.get(c.client_id)?.bought ?? 0), left_to_advise: n(c.remaining_to_advise),
      open_calls: waiting.filter((w) => w.client_id === c.client_id).length, oldest_wait_days: o?.days ?? null, cas_after_oldest: o?.casAfter ?? false,
      cas_to_check: n(c.cas_to_review), trades_to_decide: n(c.unadvised_to_review), in_bank: n(c.in_bank),
      buy_left: n(c.yet_to_advise_buy), follow_ups: n(c.follow_ups_due),
    };
    const s = sipOf.get(c.client_id);
    return {
      client_id: c.client_id, name: c.full_name, code: c.client_code, advisor: c.advisor_name ?? null,
      status: clientStatus(facts),
      sold: doneOf.get(c.client_id)?.sold ?? 0, sell_pending: waitOf(c.client_id, "SELL") + n(c.yet_to_advise_sell),
      bought: doneOf.get(c.client_id)?.bought ?? 0, buy_pending: waitOf(c.client_id, "BUY") + n(c.yet_to_advise_buy),
      idle: n(c.in_bank), sip_gap: s ? Math.max(0, s.target - s.running) : 0,
      next: nextAction(facts),
    };
  });

  const months = await tx<MonthRow[]>`
    with m as (
      select generate_series(date_trunc('month', ${f.from}::date), date_trunc('month', ${f.to}::date), interval '1 month')::date as month
    ), cl as (
      select c.id from public.clients c ${primaryAdvisor(tx)}
      where c.deleted_at is null and (${adv}::uuid is null or adv.advisor_id = ${adv})
    ), ex as (
      select date_trunc('month', e.execution_date)::date as month, e.client_id, case when ai.action = 'BUY' then 'BUY' else 'SELL' end as action, e.executed_amount
      from public.executions e join public.advice_items ai on ai.id = e.advice_item_id
      where e.status in ('EXECUTED', 'PARTIAL')
        and e.client_id in (select id from cl) and e.execution_date between ${f.from}::date and ${f.to}::date
    )
    select to_char(m.month, 'YYYY-MM') as month,
      (select count(*) from public.advisory_plans p where p.client_id in (select id from cl) and p.status <> 'CANCELLED'
         and date_trunc('month', p.plan_date)::date = m.month)::int as reports,
      (select count(*) from public.portfolio_snapshots s where s.client_id in (select id from cl) and s.review_status = 'CONFIRMED'
         and not s.is_correction and s.source <> 'MANUAL'
         and date_trunc('month', (coalesce(s.reviewed_at, s.created_at) at time zone 'Asia/Kolkata'))::date = m.month)::int as cas_checks,
      (select count(*) from public.client_agreements a where a.client_id in (select id from cl) and a.status = 'SIGNED'
         and date_trunc('month', a.signed_on)::date = m.month)::int as agreements,
      (select count(distinct x.client_id) from ex x where x.month = m.month and x.action = 'SELL')::int as sell_clients,
      coalesce((select sum(x.executed_amount) from ex x where x.month = m.month and x.action = 'SELL'), 0)::float8 as sell,
      (select count(distinct x.client_id) from ex x where x.month = m.month and x.action = 'BUY')::int as buy_clients,
      coalesce((select sum(x.executed_amount) from ex x where x.month = m.month and x.action = 'BUY'), 0)::float8 as buy
    from m order by m.month desc`;

  const execs = await tx<{ date: string; client_id: string; client: string; side: "SELL" | "BUY"; fund: string; amount: number; verification_type: string; cas_verified: boolean; call: string }[]>`
    select e.execution_date::text as date, c.id as client_id, c.full_name as client, case when ai.action = 'BUY' then 'BUY' else 'SELL' end as side, ai.scheme_name as fund,
           e.executed_amount::float8 as amount, e.verification_type, e.cas_verified_at is not null as cas_verified, b.batch_code as call
    from public.executions e
    join public.advice_items ai on ai.id = e.advice_item_id
    join public.advice_batches b on b.id = ai.advice_batch_id
    join public.clients c on c.id = e.client_id and c.deleted_at is null
    ${primaryAdvisor(tx)}
    where e.status in ('EXECUTED', 'PARTIAL')
      and e.execution_date between ${f.from}::date and ${f.to}::date
      and (${adv}::uuid is null or adv.advisor_id = ${adv})
    order by e.execution_date desc, e.created_at desc
    limit 1000`;
  // Trades no call explains (a CAS showed them; not later recorded as our call): the client's own, or still to decide.
  const own = await tx<TxnRow[]>`
    select coalesce(m.transaction_date, cs.snapshot_date)::text as date, c.id as client_id, c.full_name as client,
           case when coalesce(m.transaction_amount, 0) < 0 or m.change_type in ('DECREASE', 'EXITED') then 'SELL' else 'BUY' end as side,
           m.scheme_name as fund, abs(coalesce(m.transaction_amount, m.approx_amount))::float8 as amount,
           -- Client's own once a person said so; until then it is a question in the CAS inbox.
           case when m.reviewed_at is not null then 'OFF' else 'OPEN' end as proof, null as call
    from public.reconciliation_matches m
    join public.reconciliation_runs r on r.id = m.run_id and r.status <> 'CANCELLED'
    join public.portfolio_snapshots cs on cs.id = r.current_snapshot_id
    join public.clients c on c.id = m.client_id and c.deleted_at is null
    ${primaryAdvisor(tx)}
    where m.classification = 'UNADVISED' and m.execution_id is null and m.status <> 'REJECTED'
      and coalesce(m.transaction_date, cs.snapshot_date) between ${f.from}::date and ${f.to}::date
      and (${adv}::uuid is null or adv.advisor_id = ${adv})
    limit 1000`;
  const txns: TxnRow[] = [
    ...execs.map((e) => ({ date: e.date, client_id: e.client_id, client: e.client, side: e.side, fund: e.fund, amount: e.amount, proof: proofOf(e), call: e.call })),
    ...own.map((o) => ({ ...o, amount: Number(o.amount) })),
  ].sort((a, b) => b.date.localeCompare(a.date));

  return { kpis, months: months.map((m) => ({ ...m, sell: Number(m.sell), buy: Number(m.buy) })), book, txns };
}

/** Advisors to pick from (anyone who is the primary advisor of a client). */
export async function listOverviewAdvisors(tx: Tx): Promise<{ id: string; name: string }[]> {
  return tx<{ id: string; name: string }[]>`
    select distinct pr.id, pr.full_name as name
    from public.client_advisor_assignments a join public.profiles pr on pr.id = a.advisor_id
    where a.is_active and a.assignment_role = 'PRIMARY'
    order by pr.full_name`;
}
