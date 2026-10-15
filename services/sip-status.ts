/**
 * SIP status of a client: previous CAS vs latest CAS, plus whether each SIP
 * change in the active plan shows up in the CAS.
 */
import { setAuditReason, type Tx } from "@/lib/db/tx";
import { logServerError } from "@/lib/errors";
import { planSipMet, sipStatus, type SipFundStatus, type SipPoint, type SipTxn } from "@/lib/domain/sip-status";

export interface PlanSipCheck {
  id: string;
  action: "START" | "STOP" | "CHANGE";
  scheme_name: string;
  isin: string | null;
  old_amount: number | null;
  new_amount: number | null;
  status: string;
  met: boolean;
  /** The fund's SIP in the latest CAS (the folio that is running, if any). */
  now: SipPoint | null;
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
    select t.transaction_date::text as date, public.txn_effective_type(t.transaction_type, t.description, t.units) as type, coalesce(t.isin, sm.isin) as isin,
           t.scheme_name, t.folio_number, t.amount, t.description
    from public.portfolio_transactions t
    left join public.security_master sm on sm.id = t.security_id
    where t.client_id = ${clientId}
      -- Plain purchases too: many SIPs only show up as a repeating monthly "Purchase".
      and (t.transaction_type in ('SIP', 'PURCHASE') or t.description ~* '(sip|systematic)')`;
  const funds = sipStatus(txns, latest, previous);

  const planned = await tx<(Omit<PlanSipCheck, "met" | "now">)[]>`
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
    return { ...p, met: planSipMet(p, now), now };
  });
  return { latestCasDate: latest, previousCasDate: previous, funds, plan };
}

/**
 * Tick off the active plan's SIP lines the latest CAS shows done, with evidence
 * from on or after the report date (a client often acts on the report before
 * the plan is approved, and both CAS may already be in):
 *   START / CHANGE: the SIP runs at the planned amount, last instalment on or after the report date;
 *   STOP: a CAS taken after the report shows no running SIP in that fund.
 * Idempotent; run when a CAS is confirmed, when a plan is approved, and on demand.
 */
export async function syncSipLinesFromCas(tx: Tx, clientId: string): Promise<number> {
  const open = await tx<{ id: string; action: string; status: string; report_date: string | null }[]>`
    select s.id, s.action, s.status, p.plan_date::text as report_date
    from public.sip_plan_items s join public.advisory_plans p on p.id = s.plan_id and p.status = 'ACTIVE'
    where s.client_id = ${clientId} and s.status in ('PLANNED', 'ADVISED') and s.security_id is not null`;
  if (!open.length) return 0;
  const view = await getSipStatus(tx, clientId);
  const latest = view.latestCasDate;
  if (!latest) return 0;
  let done = 0;
  for (const line of open) {
    const p = view.plan.find((x) => x.id === line.id);
    if (!p) continue;
    const from = line.report_date ?? "0000-00-00";
    // A SIP started in the fund since the report, at another amount: the call was given (advised), not done as planned.
    if (!p.met && p.action !== "STOP" && line.status === "PLANNED" && p.now?.state === "ACTIVE" && p.now.lastInstalment && p.now.lastInstalment >= from) {
      await setAuditReason(tx, "SIP seen in CAS at another amount");
      const rows = await tx`
        update public.sip_plan_items set status = 'ADVISED', advised_at = coalesce(advised_at, now()),
          notes = coalesce(notes || E'\n', '') || ${`CAS of ${latest}: SIP of ₹${(p.now.amount ?? 0).toLocaleString("en-IN")} running (plan ₹${(p.new_amount ?? 0).toLocaleString("en-IN")})`}
        where id = ${line.id} and status = 'PLANNED' returning id`;
      done += rows.length;
      continue;
    }
    if (!p.met) continue;
    const evidence = p.action === "STOP"
      ? latest > from
      : Boolean(p.now?.lastInstalment && p.now.lastInstalment >= from);
    if (!evidence) continue;
    const note = p.action === "STOP"
      ? `Verified from CAS of ${latest}: no SIP running${p.now?.cancelledOn ? ` (cancelled ${p.now.cancelledOn})` : ""}`
      : `Verified from CAS of ${latest}: SIP of ₹${(p.now?.amount ?? 0).toLocaleString("en-IN")} running, last instalment ${p.now?.lastInstalment}`;
    await setAuditReason(tx, `SIP ${p.action.toLowerCase()} seen in CAS`);
    const rows = await tx`
      update public.sip_plan_items set status = 'COMPLETED', completed_at = coalesce(completed_at, now()),
        notes = coalesce(notes || E'\n', '') || ${note}
      where id = ${line.id} and status in ('PLANNED', 'ADVISED') returning id`;
    done += rows.length;
  }
  return done;
}

/**
 * The same check when a client's page opens, so lines follow the CAS without
 * anyone clicking. Runs in a savepoint: a failure is logged and never breaks the page.
 */
export async function syncSipLinesQuietly(tx: Tx, clientId: string): Promise<void> {
  try {
    await (tx as unknown as { savepoint: (cb: (sp: Tx) => Promise<unknown>) => Promise<unknown> }).savepoint((sp) => syncSipLinesFromCas(sp, clientId));
  } catch (e) {
    logServerError("sip-sync", e);
  }
}
