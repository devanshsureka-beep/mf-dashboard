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
  /** Funds whose SIP the report says to continue (a Keep line: "SIP ₹15,000 continues"), by ISIN. */
  continuing: { isin: string | null; scheme_name: string; amount: number | null }[];
}

export async function getSipStatus(tx: Tx, clientId: string): Promise<SipStatusView> {
  const snaps = await tx<{ snapshot_date: string }[]>`
    select snapshot_date::text from public.portfolio_snapshots
    where client_id = ${clientId} and review_status = 'CONFIRMED' and not is_correction
    group by snapshot_date order by snapshot_date desc limit 2`;
  const latest = snaps[0]?.snapshot_date ?? null;
  const previous = snaps[1]?.snapshot_date ?? null;
  // SIPs the report keeps as they are: shown even before the first CAS.
  const continuing = await continuingSips(tx, clientId);
  if (!latest) return { latestCasDate: null, previousCasDate: null, funds: [], plan: [], continuing };

  const txns = await tx<SipTxn[]>`
    select t.transaction_date::text as date, public.txn_effective_type(t.transaction_type, t.description, t.units) as type, coalesce(t.isin, sm.isin) as isin,
           t.scheme_name, t.folio_number, t.amount, t.description
    from public.portfolio_transactions t
    left join public.security_master sm on sm.id = t.security_id
    where t.client_id = ${clientId}
      -- Rows without units: only the "SIP Cancelled" kind (an invalid purchase or a refund moved nothing).
      and (coalesce(t.units, 0) <> 0 or t.description ~* '(cancel|ceas|terminat|discontinu|deactivat|revok)')
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
  return { latestCasDate: latest, previousCasDate: previous, funds, plan, continuing };
}

/** SIPs the active plan keeps unchanged: the report's own SIP table, plus plan lines whose note says the SIP continues. */
async function continuingSips(tx: Tx, clientId: string): Promise<SipStatusView["continuing"]> {
  const keepNotes = await tx<{ isin: string; scheme_name: string; reason: string }[]>`
    select sm.isin, i.scheme_name, i.reason
    from public.advisory_plan_items i
    join public.advisory_plans p on p.id = i.plan_id and p.status = 'ACTIVE'
    join public.security_master sm on sm.id = i.security_id
    where i.client_id = ${clientId} and i.status <> 'CANCELLED' and sm.isin is not null
      and i.reason ~* '(sip|systematic)[^;]{0,40}(\\mcontinu|\\mrunning\\M|\\mas is\\M|\\munchanged|\\mno change)|(\\mcontinu|\\munchanged|\\mno change in)[^;]{0,20}(sip|systematic)'
      and i.reason !~* '(discontinu|\\mstop|\\mceas|\\mcancel|\\mterminat)'`;
  const fromNotes = keepNotes.map((k) => {
    const m = /(?:sip|systematic)[^0-9₹]{0,20}(?:₹|rs\.?\s*)?([\d,]+(?:\.\d+)?)/i.exec(k.reason);
    const amount = m ? Number(m[1].replace(/,/g, "")) : null;
    return { isin: k.isin, scheme_name: k.scheme_name, amount: amount && amount >= 100 ? amount : null };
  });
  // The report's own SIP table: rows with the same amount before and after (kept with the plan since 2026-10).
  const fromTable = await tx<{ isin: string | null; scheme_name: string; amount: number }[]>`
    select u->>'isin' as isin, u->>'scheme_name' as scheme_name, (u->>'amount')::float8 as amount
    from public.advisory_plans p cross join lateral jsonb_array_elements(coalesce(p.extraction_payload->'unchanged_sips', '[]'::jsonb)) u
    -- An additional-investment report is merged into the active plan: its unchanged SIPs count too.
    where p.client_id = ${clientId} and (p.status = 'ACTIVE' or (p.status = 'MERGED' and p.merged_into_plan_id in (
      select a.id from public.advisory_plans a where a.client_id = ${clientId} and a.status = 'ACTIVE')))`;
  const continuing: SipStatusView["continuing"] = [];
  for (const c of [...fromTable, ...fromNotes]) {
    const isin = c.isin ?? null;
    if (continuing.some((x) => (isin && x.isin === isin) || (!isin && x.scheme_name === c.scheme_name))) continue;
    continuing.push({ isin, scheme_name: c.scheme_name, amount: c.amount });
  }
  return continuing;
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
  const open = await tx<{ id: string; action: string; status: string; frequency: string | null; old_amount: number | null; report_date: string | null }[]>`
    select s.id, s.action, s.status, s.frequency, s.old_amount::float8 as old_amount, p.plan_date::text as report_date
    from public.sip_plan_items s join public.advisory_plans p on p.id = s.plan_id and p.status = 'ACTIVE'
    where s.client_id = ${clientId} and s.status in ('PLANNED', 'ADVISED') and s.security_id is not null`;
  if (!open.length) return 0;
  const view = await getSipStatus(tx, clientId);
  const latest = view.latestCasDate;
  if (!latest) return 0;
  let done = 0;
  for (const line of open) {
    const p = view.plan.find((x) => x.id === line.id);
    // Without the fund's ISIN, or for a SIP that is not monthly, the CAS cannot tell: leave it to the desk.
    if (!p?.isin || (line.frequency && line.frequency !== "MONTHLY")) continue;
    const from = line.report_date ?? "0000-00-00";
    // A SIP started in the fund since the report, at another amount: the call was given (advised), not done as planned.
    // (A CHANGE counts only when the running amount is not the old one: the old SIP still running is no sign of advice.)
    const oldStillRunning = p.action === "CHANGE" && line.old_amount != null && p.now?.amount != null
      && Math.abs(p.now.amount - line.old_amount) <= Math.max(50, line.old_amount * 0.05);
    if (!p.met && p.action !== "STOP" && !oldStillRunning && line.status === "PLANNED" && p.now?.state === "ACTIVE" && p.now.lastInstalment && p.now.lastInstalment >= from) {
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
      // Stopped only when the CAS shows this fund's SIP and it is not running (a fund the CAS does not show proves nothing).
      ? latest > from && p.now != null && p.now.state !== "ACTIVE" && Boolean(p.now.lastInstalment)
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
export async function syncSipLinesQuietly(tx: Tx, clientId: string): Promise<number> {
  try {
    return (await (tx as unknown as { savepoint: <T>(cb: (sp: Tx) => Promise<T>) => Promise<T> }).savepoint((sp) => syncSipLinesFromCas(sp, clientId)));
  } catch (e) {
    logServerError("sip-sync", e);
    return 0;
  }
}
