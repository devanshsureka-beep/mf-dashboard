/**
 * SIP status of a client: previous CAS vs latest CAS, plus whether each SIP
 * change in the active plan shows up in the CAS.
 */
import type { Tx } from "@/lib/db/tx";
import { planSipMet, sipStatus, type SipFundStatus, type SipTxn } from "@/lib/domain/sip-status";

export interface PlanSipCheck {
  id: string;
  action: "START" | "STOP" | "CHANGE";
  scheme_name: string;
  isin: string | null;
  old_amount: number | null;
  new_amount: number | null;
  status: string;
  met: boolean;
}

export interface SipStatusView {
  latestCasDate: string | null;
  previousCasDate: string | null;
  funds: SipFundStatus[];
  plan: PlanSipCheck[];
}

export async function getSipStatus(tx: Tx, clientId: string): Promise<SipStatusView> {
  const snaps = await tx<{ snapshot_date: string }[]>`
    select snapshot_date::text from public.portfolio_snapshots
    where client_id = ${clientId} and review_status = 'CONFIRMED'
    group by snapshot_date order by snapshot_date desc limit 2`;
  const latest = snaps[0]?.snapshot_date ?? null;
  const previous = snaps[1]?.snapshot_date ?? null;
  if (!latest) return { latestCasDate: null, previousCasDate: null, funds: [], plan: [] };

  const txns = await tx<SipTxn[]>`
    select t.transaction_date::text as date, t.transaction_type as type, coalesce(t.isin, sm.isin) as isin,
           t.scheme_name, t.folio_number, t.amount, t.description
    from public.portfolio_transactions t
    left join public.security_master sm on sm.id = t.security_id
    where t.client_id = ${clientId}
      -- Plain purchases too: many SIPs only show up as a repeating monthly "Purchase".
      and (t.transaction_type in ('SIP', 'PURCHASE') or t.description ~* '(sip|systematic)')`;
  const funds = sipStatus(txns, latest, previous);

  const planned = await tx<(Omit<PlanSipCheck, "met">)[]>`
    select s.id, s.action, s.scheme_name, sm.isin, s.old_amount, s.new_amount, s.status
    from public.sip_plan_items s
    join public.advisory_plans p on p.id = s.plan_id and p.status = 'ACTIVE'
    left join public.security_master sm on sm.id = s.security_id
    where s.client_id = ${clientId} and s.status <> 'CANCELLED'
    order by s.action, s.scheme_name`;
  const plan = planned.map((p) => {
    // A plan SIP may sit in any folio of the fund: take the folio that is running, if any.
    const matches = funds.filter((f) => p.isin && f.isin === p.isin);
    const now = matches.find((m) => m.now.state === "ACTIVE")?.now ?? matches[0]?.now ?? null;
    return { ...p, met: planSipMet(p, now) };
  });
  return { latestCasDate: latest, previousCasDate: previous, funds, plan };
}
