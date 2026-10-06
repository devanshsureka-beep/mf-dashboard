import type { Tx } from "@/lib/db/tx";
import { AppError } from "@/lib/errors";

/**
 * A client's monthly report: what we advised in the month, what they executed,
 * where the plan stands, SIPs, trades without advice, and the portfolio at the
 * start and end of the month. All plan numbers come from the database views.
 */

export interface MonthlyReport {
  month: string; // YYYY-MM-01
  monthEnd: string; // YYYY-MM-last
  label: string; // "September 2026"
  startValue: { date: string; value: number } | null;
  endValue: { date: string; value: number } | null;
  calls: { id: string; at: Date; action: string; scheme_name: string; advised_amount: number; status: string; executed_amount: number; on_plan: boolean; channel: string }[];
  executions: { date: string; scheme_name: string; action: string; amount: number; units: number | null; verification: string }[];
  sip: { instalments: number; amount: number; byFund: { scheme_name: string; amount: number; instalments: number }[] };
  unadvised: { date: string | null; scheme_name: string; amount: number; direction: string; review: string }[];
  holdings: { scheme_name: string; category: string | null; value: number; weight: number }[];
  categories: { category: string; value: number; weight: number }[];
  totals: { advised: number; advisedSell: number; advisedBuy: number; executed: number; executedSell: number; executedBuy: number; callCount: number };
}

export function monthBounds(ym: string): { start: string; end: string; label: string } {
  if (!/^\d{4}-\d{2}$/.test(ym)) throw new AppError("Invalid month.");
  const [y, m] = ym.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const label = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 1)));
  return { start: `${ym}-01`, end: `${ym}-${String(last).padStart(2, "0")}`, label };
}

const CATEGORY = (c: string | null, name: string): string => {
  const s = `${c ?? ""} ${name}`.toLowerCase();
  if (/liquid|overnight|money market|debt|bond|gilt|credit|duration|income/.test(s)) return "Debt";
  if (/hybrid|balanced|multi asset|arbitrage|equity savings|asset allocation|advantage/.test(s)) return "Hybrid";
  if (/gold|silver|commodit/.test(s)) return "Gold & commodities";
  if (/international|global|us |nasdaq|overseas|taiwan|china|japan|fof/.test(s)) return "International";
  return "Equity";
};

export async function getMonthlyReport(tx: Tx, clientId: string, ym: string): Promise<MonthlyReport> {
  const { start, end, label } = monthBounds(ym);

  const snap = (cmp: "before" | "upto") => tx<{ id: string; snapshot_date: string; value: number }[]>`
    select id, snapshot_date::text, total_current_value::float8 as value from public.portfolio_snapshots
    where client_id = ${clientId} and review_status = 'CONFIRMED'
      and (case when ${cmp} = 'before' then snapshot_date < ${start}::date else snapshot_date <= ${end}::date end)
    order by snapshot_date desc, created_at desc limit 1`;
  const [s0, s1] = await Promise.all([snap("before"), snap("upto")]);

  const calls = await tx<MonthlyReport["calls"]>`
    select v.id, v.communicated_at as at, v.action, v.scheme_name, v.advised_amount::float8 as advised_amount, v.status,
           v.executed_amount::float8 as executed_amount, v.plan_item_id is not null as on_plan, b.communication_channel as channel
    from public.v_advice_items v join public.advice_batches b on b.id = v.advice_batch_id
    where v.client_id = ${clientId}
      and (v.communicated_at at time zone 'Asia/Kolkata')::date between ${start}::date and ${end}::date
    order by v.communicated_at`;

  const executions = await tx<MonthlyReport["executions"]>`
    select e.execution_date::text as date, ai.scheme_name, ai.action, e.executed_amount::float8 as amount,
           e.executed_units::float8 as units, e.verification_type as verification
    from public.executions e join public.advice_items ai on ai.id = e.advice_item_id
    where e.client_id = ${clientId} and e.status in ('EXECUTED', 'PARTIAL')
      and e.execution_date between ${start}::date and ${end}::date
    order by e.execution_date`;

  const sipRows = await tx<{ scheme_name: string; amount: number; instalments: number }[]>`
    select scheme_name, sum(abs(amount))::float8 as amount, count(*)::int as instalments
    from public.portfolio_transactions
    where client_id = ${clientId} and transaction_type = 'SIP' and coalesce(amount, 0) <> 0
      and transaction_date between ${start}::date and ${end}::date
    group by scheme_name order by 2 desc`;

  const unadvised = await tx<MonthlyReport["unadvised"]>`
    select m.transaction_date::text as date, m.scheme_name, m.approx_amount::float8 as amount,
           (case when m.change_type = 'DECREASE' then 'Redeemed' else 'Invested' end) as direction,
           (case when m.status = 'REJECTED' and m.resolution_note like 'Recorded as advised%' then 'Advised (recorded later)'
                 when m.reviewed_at is not null then 'Client acted on their own'
                 else 'To review' end) as review
    from public.reconciliation_matches m join public.reconciliation_runs r on r.id = m.run_id
    where m.client_id = ${clientId} and r.status <> 'CANCELLED' and m.classification = 'UNADVISED'
      and m.transaction_date between ${start}::date and ${end}::date
      and not (m.status = 'REJECTED' and coalesce(m.resolution_note, '') like 'History:%')
    order by m.transaction_date`;

  const holdings = s1[0] ? await tx<{ scheme_name: string; category: string | null; value: number }[]>`
    select h.scheme_name, h.category, sum(h.current_value)::float8 as value
    from public.portfolio_holdings h where h.snapshot_id = ${s1[0].id}
    group by h.scheme_name, h.category order by 3 desc` : [];
  const total = holdings.reduce((t, h) => t + h.value, 0) || 1;
  const cat = new Map<string, number>();
  for (const h of holdings) cat.set(CATEGORY(h.category, h.scheme_name), (cat.get(CATEGORY(h.category, h.scheme_name)) ?? 0) + h.value);

  const sum = (xs: number[]) => xs.reduce((t, x) => t + x, 0);
  return {
    month: start, monthEnd: end, label,
    startValue: s0[0] ? { date: s0[0].snapshot_date, value: s0[0].value } : null,
    endValue: s1[0] ? { date: s1[0].snapshot_date, value: s1[0].value } : null,
    calls, executions,
    sip: { instalments: sum(sipRows.map((r) => r.instalments)), amount: sum(sipRows.map((r) => r.amount)), byFund: sipRows },
    unadvised,
    holdings: holdings.map((h) => ({ ...h, weight: h.value / total })),
    categories: [...cat.entries()].map(([category, value]) => ({ category, value, weight: value / total })).sort((a, b) => b.value - a.value),
    totals: {
      advised: sum(calls.map((c) => c.advised_amount)),
      advisedSell: sum(calls.filter((c) => c.action !== "BUY").map((c) => c.advised_amount)),
      advisedBuy: sum(calls.filter((c) => c.action === "BUY").map((c) => c.advised_amount)),
      executed: sum(executions.map((e) => e.amount)),
      executedSell: sum(executions.filter((e) => e.action !== "BUY").map((e) => e.amount)),
      executedBuy: sum(executions.filter((e) => e.action === "BUY").map((e) => e.amount)),
      callCount: calls.length,
    },
  };
}
