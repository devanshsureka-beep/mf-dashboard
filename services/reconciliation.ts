import type { Actor, Tx } from "@/lib/db/tx";
import { setAuditReason } from "@/lib/db/tx";
import { AppError } from "@/lib/errors";
import {
  ENGINE_VERSION,
  reconcile,
  type CandidateAdvice,
  type CasTxnLine,
  type HoldingLine,
} from "@/lib/domain/reconciliation";
import type { ReconciliationMatchRow, ReconciliationRunRow } from "@/types/domain";

// -----------------------------------------------------------------------------
// Run
// -----------------------------------------------------------------------------
export async function runReconciliation(
  tx: Tx,
  actor: Actor | null,
  args: { clientId: string; currentSnapshotId: string; previousSnapshotId?: string | null },
): Promise<{ runId: string; existing: boolean }> {
  const curr = await tx<{ id: string; client_id: string; snapshot_date: string; created_at: Date; review_status: string; total_current_value: number }[]>`
    select id, client_id, snapshot_date, created_at, review_status, total_current_value
    from public.portfolio_snapshots where id = ${args.currentSnapshotId}`;
  if (!curr[0] || curr[0].client_id !== args.clientId) throw new AppError("Snapshot not found for this client.", "NOT_FOUND");
  if (curr[0].review_status !== "CONFIRMED") throw new AppError("Only CONFIRMED snapshots can be reconciled. Review the extraction first.");

  const prev = await tx<{ id: string; snapshot_date: string; total_current_value: number }[]>`
    select id, snapshot_date, total_current_value from public.portfolio_snapshots
    where client_id = ${args.clientId} and review_status = 'CONFIRMED'
      and (${args.previousSnapshotId ?? null}::uuid is null and id <> ${args.currentSnapshotId}
             and (snapshot_date, created_at) < (${curr[0].snapshot_date}::date, ${curr[0].created_at})
           or id = ${args.previousSnapshotId ?? null})
    order by snapshot_date desc, created_at desc limit 1`;
  if (!prev[0]) throw new AppError("There is no earlier confirmed snapshot to compare against (this is the baseline).");

  const existing = await tx<{ id: string }[]>`
    select id from public.reconciliation_runs
    where previous_snapshot_id = ${prev[0].id} and current_snapshot_id = ${args.currentSnapshotId} and status <> 'CANCELLED'`;
  if (existing[0]) return { runId: existing[0].id, existing: true };

  const holdings = (snapshotId: string) => tx<{
    security_id: string | null; isin: string | null; scheme_name: string; folio_number: string | null;
    units: number; current_value: number; latest_nav: number | null;
  }[]>`
    select security_id, isin, scheme_name, folio_number, units, current_value, latest_nav
    from public.portfolio_holdings where snapshot_id = ${snapshotId}`;
  const toLine = (h: Awaited<ReturnType<typeof holdings>>[number]): HoldingLine => ({
    securityId: h.security_id, isin: h.isin, schemeName: h.scheme_name, folioNumber: h.folio_number,
    units: h.units, currentValue: h.current_value, nav: h.latest_nav,
  });
  const [prevHoldings, currHoldings] = await Promise.all([holdings(prev[0].id), holdings(args.currentSnapshotId)]);

  // Candidates: open calls + calls with executions not yet CAS-verified.
  const adviceRows = await tx<{
    id: string; security_id: string; action: "BUY" | "SELL" | "SWITCH"; status: "ISSUED" | "PARTIALLY_EXECUTED" | "EXECUTED";
    quantity_basis: "AMOUNT" | "UNITS"; advised_amount: number; advised_units: number | null; executed_amount: number;
    executed_units: number; reference_price: number | null; communicated_at: Date;
    unverified_amount: number; unverified_units: number;
  }[]>`
    select v.id, v.security_id, v.action, v.status, v.quantity_basis, v.advised_amount, v.advised_units,
           v.executed_amount, v.executed_units, v.reference_price, v.communicated_at,
           coalesce(u.amount, 0) as unverified_amount, coalesce(u.units, 0) as unverified_units
    from public.v_advice_items v
    left join lateral (
      select sum(e.executed_amount) as amount, sum(coalesce(e.executed_units, 0)) as units
      from public.executions e
      where e.advice_item_id = v.id and e.status in ('EXECUTED', 'PARTIAL')
        and e.cas_verified_at is null and e.verification_type <> 'CAS_VERIFIED'
    ) u on true
    where v.client_id = ${args.clientId}
      and (v.is_open or (v.status = 'EXECUTED' and coalesce(u.amount, 0) > 0))`;
  const advice: CandidateAdvice[] = adviceRows.map((a) => ({
    id: a.id, securityId: a.security_id, action: a.action, status: a.status, quantityBasis: a.quantity_basis,
    advisedAmount: a.advised_amount, advisedUnits: a.advised_units, executedAmount: a.executed_amount,
    executedUnits: a.executed_units, unverifiedExecutedAmount: a.unverified_amount,
    unverifiedExecutedUnits: a.unverified_units, referencePrice: a.reference_price, communicatedAt: new Date(a.communicated_at),
  }));

  const txns = await tx<{ security_id: string | null; isin: string | null; scheme_name: string; transaction_type: string; units: number | null; transaction_date: string }[]>`
    select security_id, isin, scheme_name, transaction_type, units, transaction_date
    from public.portfolio_transactions
    where client_id = ${args.clientId}
      and transaction_date > ${prev[0].snapshot_date}::date and transaction_date <= ${curr[0].snapshot_date}::date`;
  const transactions: CasTxnLine[] = txns.map((t) => ({
    securityId: t.security_id, isin: t.isin, schemeName: t.scheme_name, type: t.transaction_type, units: t.units, date: t.transaction_date,
  }));

  const proposals = reconcile({
    previous: prevHoldings.map(toLine),
    current: currHoldings.map(toLine),
    advice,
    transactions,
    currentSnapshotDate: curr[0].snapshot_date,
  });

  const summary = {
    changes: new Set(proposals.map((p) => p.key)).size,
    advice_matches: proposals.filter((p) => p.classification === "ADVICE_MATCH").length,
    high_confidence: proposals.filter((p) => p.classification === "ADVICE_MATCH" && p.confidence === "HIGH").length,
    unadvised: proposals.filter((p) => p.classification === "UNADVISED").length,
    sip_instalments: proposals.filter((p) => p.classification === "SIP_INSTALMENT").length,
  };

  const run = await tx<{ id: string }[]>`
    insert into public.reconciliation_runs (client_id, previous_snapshot_id, current_snapshot_id, previous_value, current_value,
                                            summary, engine_version, status, completed_at, created_by)
    values (${args.clientId}, ${prev[0].id}, ${args.currentSnapshotId}, ${prev[0].total_current_value},
            ${curr[0].total_current_value}, ${tx.json(summary)}, ${ENGINE_VERSION},
            ${proposals.some((p) => p.status === "SUGGESTED" || p.classification === "UNADVISED") ? "OPEN" : "COMPLETED"},
            ${proposals.some((p) => p.status === "SUGGESTED" || p.classification === "UNADVISED") ? null : new Date()},
            ${actor?.id ?? null})
    returning id`;

  for (const p of proposals) {
    await tx`
      insert into public.reconciliation_matches
        (run_id, client_id, advice_item_id, security_id, scheme_name, folio_numbers, change_type, classification,
         previous_units, current_units, detected_change, previous_value, current_value, approx_amount, reference_nav,
         expected_change, expected_amount, allocated_units, confidence, status, system_note, reviewed_at)
      values (${run[0].id}, ${args.clientId}, ${p.adviceItemId}, ${p.securityId}, ${p.schemeName}, ${p.folioNumbers},
              ${p.changeType}, ${p.classification}, ${p.previousUnits}, ${p.currentUnits}, ${p.detectedChange},
              ${p.previousValue}, ${p.currentValue}, ${p.approxAmount}, ${p.referenceNav}, ${p.expectedChange},
              ${p.expectedAmount}, ${p.allocatedUnits}, ${p.confidence}, ${p.status}, ${p.systemNote},
              ${p.classification === "SIP_INSTALMENT" ? new Date() : null})`;
  }
  return { runId: run[0].id, existing: false };
}

export async function cancelRun(tx: Tx, runId: string, reason: string): Promise<void> {
  if (!reason.trim()) throw new AppError("A reason is required.");
  const resolved = await tx<{ n: number }[]>`
    select count(*)::int as n from public.reconciliation_matches where run_id = ${runId} and status in ('CONFIRMED', 'PARTIAL')`;
  if (resolved[0].n > 0) throw new AppError("This run already has confirmed matches and cannot be cancelled.");
  await setAuditReason(tx, reason);
  await tx`update public.reconciliation_runs set status = 'CANCELLED', completed_at = now() where id = ${runId} and status = 'OPEN'`;
}

// -----------------------------------------------------------------------------
// Queries
// -----------------------------------------------------------------------------
export async function listRuns(tx: Tx, f: { clientId?: string } = {}): Promise<ReconciliationRunRow[]> {
  return tx<ReconciliationRunRow[]>`
    select r.*, c.full_name as client_name, c.client_code,
           ps.snapshot_date as previous_snapshot_date, cs.snapshot_date as current_snapshot_date,
           (select count(*) from public.reconciliation_matches m
             where m.run_id = r.id and (m.status = 'SUGGESTED'
               or (m.status = 'UNEXPLAINED' and m.classification = 'UNADVISED' and m.reviewed_at is null)))::int as open_matches
    from public.reconciliation_runs r
    join public.clients c on c.id = r.client_id
    join public.portfolio_snapshots ps on ps.id = r.previous_snapshot_id
    join public.portfolio_snapshots cs on cs.id = r.current_snapshot_id
    where (${f.clientId ?? null}::uuid is null or r.client_id = ${f.clientId ?? null})
    order by r.created_at desc limit 200`;
}

export async function getRun(tx: Tx, runId: string): Promise<ReconciliationRunRow> {
  const rows = await tx<ReconciliationRunRow[]>`
    select r.*, c.full_name as client_name, c.client_code,
           ps.snapshot_date as previous_snapshot_date, cs.snapshot_date as current_snapshot_date
    from public.reconciliation_runs r
    join public.clients c on c.id = r.client_id
    join public.portfolio_snapshots ps on ps.id = r.previous_snapshot_id
    join public.portfolio_snapshots cs on cs.id = r.current_snapshot_id
    where r.id = ${runId}`;
  if (!rows[0]) throw new AppError("Reconciliation run not found.", "NOT_FOUND");
  return rows[0];
}

export async function getMatches(tx: Tx, runId: string): Promise<ReconciliationMatchRow[]> {
  return tx<ReconciliationMatchRow[]>`
    select m.*, a.action as advice_action, a.status as advice_status, b.batch_code as advice_batch_code,
           b.communicated_at as advice_communicated_at, a.advised_amount as advice_advised_amount,
           a.advised_units as advice_advised_units
    from public.reconciliation_matches m
    left join public.advice_items a on a.id = m.advice_item_id
    left join public.advice_batches b on b.id = a.advice_batch_id
    where m.run_id = ${runId}
    order by case m.status when 'SUGGESTED' then 0 when 'UNEXPLAINED' then 1 else 2 end,
             m.scheme_name, b.communicated_at nulls last`;
}

export async function listUnadvisedActivity(tx: Tx, limit = 50) {
  return tx<(ReconciliationMatchRow & { client_name: string; client_code: string; snapshot_date: string })[]>`
    select m.*, c.full_name as client_name, c.client_code, cs.snapshot_date
    from public.reconciliation_matches m
    join public.clients c on c.id = m.client_id
    join public.reconciliation_runs r on r.id = m.run_id
    join public.portfolio_snapshots cs on cs.id = r.current_snapshot_id
    where m.status = 'UNEXPLAINED' and m.classification = 'UNADVISED' and m.reviewed_at is null
    order by m.created_at desc limit ${limit}`;
}

// -----------------------------------------------------------------------------
// Resolution (human decisions)
// -----------------------------------------------------------------------------
export type MatchDecision = "CONFIRM" | "PARTIAL" | "REJECT" | "UNADVISED" | "ACKNOWLEDGE";

export async function resolveMatch(
  tx: Tx,
  actor: Actor,
  matchId: string,
  decision: MatchDecision,
  opts: { units?: number | null; amount?: number | null; note?: string | null } = {},
): Promise<{ executionId: string | null; verifiedExecutions: number }> {
  const rows = await tx<(ReconciliationMatchRow & { run_status: string; current_snapshot_date: string })[]>`
    select m.*, r.status as run_status, cs.snapshot_date as current_snapshot_date
    from public.reconciliation_matches m
    join public.reconciliation_runs r on r.id = m.run_id
    join public.portfolio_snapshots cs on cs.id = r.current_snapshot_id
    where m.id = ${matchId}
    for update of m`;
  const m = rows[0];
  if (!m) throw new AppError("Match not found.", "NOT_FOUND");
  if (m.run_status === "CANCELLED") throw new AppError("This reconciliation run was cancelled.");
  const note = opts.note?.trim() || null;
  let executionId: string | null = null;
  let verified = 0;

  if (decision === "CONFIRM" || decision === "PARTIAL") {
    if (m.status !== "SUGGESTED") throw new AppError(`Match is already ${m.status}.`);
    if (!m.advice_item_id) throw new AppError("Only advice matches can be confirmed.");
    const nav = m.reference_nav ?? 0;
    const units = decision === "PARTIAL" ? Number(opts.units) : Number(m.allocated_units ?? Math.abs(m.detected_change));
    if (!(units > 0)) throw new AppError("Enter the units that belong to this call.");
    if (units > Math.abs(m.detected_change) + 0.001) throw new AppError("Confirmed units cannot exceed the detected change.");
    const amount = decision === "PARTIAL" && opts.amount ? Number(opts.amount) : round2(units * nav);
    if (!(amount > 0)) throw new AppError("Enter the rupee amount for this execution.");
    if (decision === "PARTIAL" && !note) throw new AppError("Add a note explaining the partial match.");

    await setAuditReason(tx, note ?? `Reconciliation match confirmed (${decision})`);

    // 1) Executions already recorded manually are VERIFIED, not duplicated.
    const unverified = await tx<{ id: string; executed_amount: number }[]>`
      select id, executed_amount from public.executions
      where advice_item_id = ${m.advice_item_id} and status in ('EXECUTED', 'PARTIAL')
        and cas_verified_at is null and verification_type <> 'CAS_VERIFIED'
      order by execution_date, created_at`;
    let covered = 0;
    for (const e of unverified) {
      if (covered + e.executed_amount > amount * 1.02 + 1) break;
      await tx`update public.executions set cas_verified_at = now(), cas_verification_match_id = ${m.id} where id = ${e.id}`;
      covered += e.executed_amount;
      verified++;
    }

    // 2) The rest becomes a new CAS_VERIFIED execution.
    const remainingAmount = round2(amount - covered);
    if (remainingAmount > Math.max(1, amount * 0.01)) {
      const lastTxn = await tx<{ d: string | null }[]>`
        select max(t.transaction_date)::text as d
        from public.portfolio_transactions t
        join public.reconciliation_runs r on r.id = ${m.run_id}
        join public.portfolio_snapshots ps on ps.id = r.previous_snapshot_id
        where t.client_id = ${m.client_id} and t.security_id = ${m.security_id}
          and t.transaction_date > ps.snapshot_date and t.transaction_date <= ${m.current_snapshot_date}::date`;
      const execUnits = round4(units * (remainingAmount / amount));
      const ins = await tx<{ id: string }[]>`
        insert into public.executions (client_id, advice_item_id, security_id, execution_date, executed_amount, executed_units,
                                       execution_price, verification_type, status, notes, cas_verified_at,
                                       cas_verification_match_id, created_by)
        values (${m.client_id}, ${m.advice_item_id}, ${m.security_id}, ${lastTxn[0]?.d ?? m.current_snapshot_date},
                ${remainingAmount}, ${execUnits}, ${m.reference_nav}, 'CAS_VERIFIED', 'EXECUTED',
                ${`Verified from CAS reconciliation${note ? `: ${note}` : ""}`}, now(), ${m.id}, ${actor.id})
        returning id`;
      executionId = ins[0].id;
    }

    await tx`
      update public.reconciliation_matches set
        status = ${decision === "CONFIRM" ? "CONFIRMED" : "PARTIAL"}, confirmed_units = ${units}, confirmed_amount = ${amount},
        execution_id = ${executionId}, resolution_note = ${note}, resolved_at = now(), resolved_by = ${actor.id}
      where id = ${m.id}`;
  } else if (decision === "REJECT") {
    if (m.status !== "SUGGESTED") throw new AppError(`Match is already ${m.status}.`);
    if (!note) throw new AppError("Add a note explaining why this match is rejected.");
    await setAuditReason(tx, note);
    await tx`
      update public.reconciliation_matches set status = 'REJECTED', resolution_note = ${note}, resolved_at = now(), resolved_by = ${actor.id}
      where id = ${m.id}`;
  } else if (decision === "UNADVISED") {
    if (!["SUGGESTED", "UNEXPLAINED"].includes(m.status)) throw new AppError(`Match is already ${m.status}.`);
    await setAuditReason(tx, note ?? "Marked as unadvised activity");
    await tx`
      update public.reconciliation_matches set status = 'UNEXPLAINED', classification = 'UNADVISED', resolution_note = ${note},
        reviewed_at = null, reviewed_by = null
      where id = ${m.id}`;
  } else if (decision === "ACKNOWLEDGE") {
    if (m.status !== "UNEXPLAINED") throw new AppError("Only unexplained changes can be acknowledged.");
    if (!note) throw new AppError("Add a note (e.g. what the client said).");
    await setAuditReason(tx, note);
    await tx`
      update public.reconciliation_matches set reviewed_at = now(), reviewed_by = ${actor.id},
        resolution_note = coalesce(resolution_note || E'\n', '') || ${note}
      where id = ${m.id}`;
  }

  // Close the run once nothing needs a decision any more.
  await tx`
    update public.reconciliation_runs r set status = 'COMPLETED', completed_at = now()
    where r.id = ${m.run_id} and r.status = 'OPEN'
      and not exists (
        select 1 from public.reconciliation_matches x
        where x.run_id = r.id and (x.status = 'SUGGESTED' or (x.status = 'UNEXPLAINED' and x.reviewed_at is null)))`;

  return { executionId, verifiedExecutions: verified };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
