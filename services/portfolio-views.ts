/**
 * The two portfolio views of a client:
 *  - "At onboarding": the baseline CAS (the one the advisory report was made
 *    from), never changes.
 *  - "Current": units from the latest confirmed CAS valued at the latest NAV
 *    (v_holding_live), with the active plan's action and progress per fund.
 */
import type { Tx } from "@/lib/db/tx";

export interface LiveHolding {
  holding_id: string;
  security_id: string | null;
  scheme_name: string;
  folio_number: string | null;
  isin: string | null;
  plan_type: string | null;
  units: number;
  cas_nav: number | null;
  cas_nav_date: string | null;
  cas_value: number;
  nav: number | null;
  nav_date: string | null;
  live_value: number;
  is_live: boolean;
  cost_value: number | null;
}

export interface BaselineHolding {
  id: string;
  security_id: string | null;
  scheme_name: string;
  folio_number: string | null;
  isin: string | null;
  plan_type: string | null;
  units: number;
  latest_nav: number | null;
  latest_nav_date: string | null;
  current_value: number;
}

export interface PlanLine {
  plan_item_id: string;
  security_id: string | null;
  scheme_name: string;
  folio_number: string | null;
  action: string;
  side: "SELL" | "BUY" | "NONE";
  reason: string | null;
  current_amount: number | null;
  target_amount: number;
  advised_amount: number;
  executed_amount: number;
  pending_amount: number;
  yet_to_advise_amount: number;
  progress_status: string;
}

export interface PortfolioViews {
  baseline: { snapshot_id: string; snapshot_date: string; rows: BaselineHolding[] } | null;
  current: { snapshot_id: string; snapshot_date: string; rows: LiveHolding[] } | null;
  plan: PlanLine[];
}

const n = (v: unknown) => (v == null ? null : Number(v));

export async function getPortfolioViews(tx: Tx, clientId: string): Promise<PortfolioViews> {
  const base = await tx<{ id: string; snapshot_date: string }[]>`
    select id, snapshot_date from public.portfolio_snapshots
    where client_id = ${clientId} and is_baseline and review_status = 'CONFIRMED' limit 1`;
  const latest = await tx<{ snapshot_id: string; snapshot_date: string }[]>`
    select snapshot_id, snapshot_date from public.v_latest_snapshot where client_id = ${clientId}`;

  const baselineRows = base[0]
    ? await tx<BaselineHolding[]>`
        select id, security_id, scheme_name, folio_number, isin, plan_type, units, latest_nav, latest_nav_date, current_value
        from public.portfolio_holdings where snapshot_id = ${base[0].id} order by current_value desc`
    : [];
  const liveRows = latest[0]
    ? await tx<LiveHolding[]>`
        select holding_id, security_id, scheme_name, folio_number, isin, plan_type, units, cas_nav, cas_nav_date, cas_value,
               nav, nav_date, live_value, is_live, cost_value
        from public.v_holding_live where client_id = ${clientId} order by live_value desc`
    : [];
  const plan = await tx<PlanLine[]>`
    select v.plan_item_id, v.security_id, v.scheme_name, v.folio_number, v.action, v.side, v.reason, v.current_amount,
           v.target_amount, v.advised_amount, v.executed_amount, v.pending_amount, v.yet_to_advise_amount, v.progress_status
    from public.v_plan_item_progress v
    join public.advisory_plans p on p.id = v.plan_id and p.status = 'ACTIVE'
    where v.client_id = ${clientId} and v.item_status <> 'CANCELLED'
    order by v.priority, v.scheme_name`;

  const numify = <T extends object>(rows: T[], keys: (keyof T)[]) =>
    rows.map((r) => {
      const o = { ...r } as Record<string, unknown>;
      for (const k of keys) o[k as string] = n(o[k as string]);
      return o as T;
    });

  return {
    baseline: base[0] ? { snapshot_id: base[0].id, snapshot_date: base[0].snapshot_date, rows: numify(baselineRows, ["units", "latest_nav", "current_value"]) } : null,
    current: latest[0]
      ? { snapshot_id: latest[0].snapshot_id, snapshot_date: latest[0].snapshot_date, rows: numify(liveRows, ["units", "cas_nav", "cas_value", "nav", "live_value", "cost_value"]) }
      : null,
    plan: numify(plan, ["current_amount", "target_amount", "advised_amount", "executed_amount", "pending_amount", "yet_to_advise_amount"]),
  };
}

/** Plan line for a holding: same fund, and the same folio when the plan names one. */
export function planLineFor(plan: PlanLine[], h: { security_id: string | null; folio_number: string | null }): PlanLine | null {
  if (!h.security_id) return null;
  const same = plan.filter((p) => p.security_id === h.security_id);
  const norm = (f: string | null) => (f ?? "").replace(/[^0-9a-z]/gi, "").toLowerCase();
  return same.find((p) => p.folio_number && norm(p.folio_number) === norm(h.folio_number)) ?? same.find((p) => !p.folio_number) ?? same[0] ?? null;
}
