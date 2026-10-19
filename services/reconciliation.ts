import type { Actor, Tx } from "@/lib/db/tx";
import { setAuditReason } from "@/lib/db/tx";
import { AppError, logServerError } from "@/lib/errors";
import {
  ENGINE_VERSION,
  reconcile,
  type CandidateAdvice,
  type CasTxnLine,
  type HoldingLine,
} from "@/lib/domain/reconciliation";
import { matchTransactions, istDate, TOLERANCE as VERIFY_TOLERANCE, type MatchCall, type MatchTxn, type SwitchTarget, type TxnProposal } from "@/lib/domain/txn-matching";
import type { Channel, ReconciliationMatchRow, ReconciliationRunRow } from "@/types/domain";
import { effectiveTxnType } from "@/lib/parsers/cas";
import { bouncedPurchases } from "@/lib/domain/sip-status";
import { closeAdvice } from "./advice";
import { voidExecution } from "./executions";
import { issueAdvice } from "./advice";

export const TXN_ENGINE_VERSION = "v2-transactions";

// -----------------------------------------------------------------------------
// Run
// -----------------------------------------------------------------------------
export async function runReconciliation(
  tx: Tx,
  actor: Actor | null,
  args: { clientId: string; currentSnapshotId: string; previousSnapshotId?: string | null },
): Promise<{ runId: string; existing: boolean }> {
  const curr = await tx<{ id: string; client_id: string; snapshot_date: string; created_at: Date; review_status: string; total_current_value: number; is_correction: boolean }[]>`
    select id, client_id, snapshot_date, created_at, review_status, total_current_value, is_correction
    from public.portfolio_snapshots where id = ${args.currentSnapshotId}`;
  if (!curr[0] || curr[0].client_id !== args.clientId) throw new AppError("Snapshot not found for this client.", "NOT_FOUND");
  if (curr[0].review_status !== "CONFIRMED") throw new AppError("Only CONFIRMED snapshots can be reconciled. Review the extraction first.");
  if (curr[0].is_correction) throw new AppError("A holdings correction is not a CAS: only a CAS is matched against calls.");

  const prev = await tx<{ id: string; snapshot_date: string; total_current_value: number }[]>`
    select id, snapshot_date, total_current_value from public.portfolio_snapshots
    where client_id = ${args.clientId} and review_status = 'CONFIRMED' and not is_correction
      and (${args.previousSnapshotId ?? null}::uuid is null and id <> ${args.currentSnapshotId}
             and (snapshot_date, created_at) < (${curr[0].snapshot_date}::date, ${curr[0].created_at})
           or id = ${args.previousSnapshotId ?? null})
    order by snapshot_date desc, created_at desc limit 1`;
  if (!prev[0]) throw new AppError("There is no earlier confirmed snapshot to compare against (this is the baseline).");

  const existing = await tx<{ id: string }[]>`
    select id from public.reconciliation_runs
    where previous_snapshot_id = ${prev[0].id} and current_snapshot_id = ${args.currentSnapshotId} and status <> 'CANCELLED'`;
  if (existing[0]) return { runId: existing[0].id, existing: true };

  // A detailed CAS (with transactions) is reconciled transaction by transaction.
  const txnCount = await tx<{ n: number }[]>`
    select count(*)::int as n from public.portfolio_snapshot_transactions where snapshot_id = ${args.currentSnapshotId}`;
  if (txnCount[0].n > 0) {
    return runTransactionReconciliation(tx, actor, {
      clientId: args.clientId,
      previous: prev[0],
      current: curr[0],
    });
  }

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
    select security_id, isin, scheme_name, public.txn_effective_type(transaction_type, description, units) as transaction_type, units, transaction_date
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

// -----------------------------------------------------------------------------
// Engine v2: CAS transactions -> calls. Clear matches are confirmed
// automatically (the execution gets the CAS date, amount, units and NAV);
// everything else waits for a person.
// -----------------------------------------------------------------------------
export interface TxnRunSummary {
  transactions: number;
  advice_matches: number;
  auto_confirmed: number;
  needs_review: number;
  unadvised: number;
  sip_instalments: number;
  sip_cancellations: number;
  sip_items_completed: number;
}

/** Open calls (and calls with unverified executions) a CAS transaction may match. */
async function loadMatchCalls(tx: Tx, clientId: string): Promise<{ calls: MatchCall[]; switchTargets: SwitchTarget[] }> {
  const callRows = await tx<{
    id: string; security_id: string; isin: string | null; action: "BUY" | "SELL" | "SWITCH";
    status: "ISSUED" | "PARTIALLY_EXECUTED" | "EXECUTED"; quantity_basis: "AMOUNT" | "UNITS";
    advised_amount: number; advised_units: number | null; executed_amount: number; executed_units: number;
    communicated_at: Date; unverified_amount: number; unverified_units: number; folio_number: string | null;
    suggested_amount: number; suggested_units: number;
  }[]>`
    select v.id, v.security_id, sm.isin, v.action, v.status, v.quantity_basis, v.advised_amount, v.advised_units, v.folio_number,
           v.executed_amount, v.executed_units, v.communicated_at,
           coalesce(u.amount, 0) as unverified_amount, coalesce(u.units, 0) as unverified_units,
           coalesce(sg.amount, 0) as suggested_amount, coalesce(sg.units, 0) as suggested_units
    from public.v_advice_items v
    join public.security_master sm on sm.id = v.security_id
    left join lateral (
      select sum(e.executed_amount) as amount, sum(coalesce(e.executed_units, 0)) as units
      from public.executions e
      where e.advice_item_id = v.id and e.status in ('EXECUTED', 'PARTIAL')
        and e.cas_verified_at is null and e.verification_type <> 'CAS_VERIFIED'
    ) u on true
    -- Matches already proposed for this call and still awaiting a decision: that part is spoken for.
    left join lateral (
      select sum(m.approx_amount) as amount, sum(abs(coalesce(m.allocated_units, 0))) as units
      from public.reconciliation_matches m join public.reconciliation_runs r on r.id = m.run_id
      where m.advice_item_id = v.id and m.status = 'SUGGESTED' and r.status <> 'CANCELLED'
    ) sg on true
    where v.client_id = ${clientId}
      and (v.is_open or (v.status = 'EXECUTED' and coalesce(u.amount, 0) > 0))`;
  const calls: MatchCall[] = callRows.map((a) => ({
    id: a.id, securityId: a.security_id, isin: a.isin, action: a.action, status: a.status,
    quantityBasis: a.quantity_basis, advisedAmount: Number(a.advised_amount),
    advisedUnits: a.advised_units === null ? null : Number(a.advised_units),
    executedAmount: Number(a.executed_amount) + Number(a.suggested_amount),
    executedUnits: Number(a.executed_units) + Number(a.suggested_units),
    // A call already done by hand: its hand-recorded part, less what pending suggestions already claim (an open call
    // has them in executed above). Otherwise one hand-recorded execution could be verified by two CAS trades.
    unverifiedExecutedAmount: a.status === "EXECUTED" ? Math.max(Number(a.unverified_amount) - Number(a.suggested_amount), 0) : Number(a.unverified_amount),
    unverifiedExecutedUnits: a.status === "EXECUTED" ? Math.max(Number(a.unverified_units) - Number(a.suggested_units), 0) : Number(a.unverified_units),
    communicatedAt: new Date(a.communicated_at), folio: a.folio_number,
  }));

  // Targets of advised switches: their switch-in legs are not new purchases.
  const switchTargets: SwitchTarget[] = (await tx<{ security_id: string; isin: string | null; communicated_at: Date }[]>`
    select pi.switch_to_security_id as security_id, sm.isin, v.communicated_at
    from public.v_advice_items v
    join public.advisory_plan_items pi on pi.id = v.plan_item_id
    join public.security_master sm on sm.id = pi.switch_to_security_id
    where v.client_id = ${clientId} and v.action = 'SWITCH'
      and v.status in ('ISSUED', 'PARTIALLY_EXECUTED', 'EXECUTED')`)
    .map((r) => ({ securityId: r.security_id, isin: r.isin, communicatedAt: new Date(r.communicated_at) }));
  return { calls, switchTargets };
}

/**
 * Transactions first seen in a CAS (overlapping statements are de-duplicated on
 * insert) and dated after the previous CAS: a full-history statement also lists
 * years of older trades, which are history, not changes. Optionally only those a
 * run has not matched yet.
 */
async function loadSnapshotTxns(tx: Tx, snapshotId: string, afterDate: string, notInRunId: string | null = null) {
  const txnRows = await tx<{
    id: string; security_id: string | null; isin: string | null; scheme_name: string; folio_number: string | null;
    transaction_date: string; transaction_type: string; description: string | null;
    amount: number | null; units: number | null; nav: number | null;
  }[]>`
    select t.id, t.security_id, t.isin, t.scheme_name, t.folio_number, t.transaction_date::text as transaction_date,
           t.transaction_type, t.description, t.amount, t.units, t.nav
    from public.portfolio_transactions t
    join public.portfolio_snapshot_transactions l on l.transaction_id = t.id and l.snapshot_id = ${snapshotId}
    where t.transaction_date > ${afterDate}::date
      and (${notInRunId}::uuid is null or not exists (
        select 1 from public.reconciliation_matches m where m.run_id = ${notInRunId} and m.cas_transaction_id = t.id))
    order by t.transaction_date, t.created_at`;
  const all: MatchTxn[] = txnRows.map((t) => ({
    id: t.id, securityId: t.security_id, isin: t.isin, schemeName: t.scheme_name, date: t.transaction_date,
    type: effectiveTxnType(t.transaction_type, t.description, t.units), description: t.description,
    amount: t.amount === null ? null : Number(t.amount), units: t.units === null ? null : Number(t.units),
    nav: t.nav === null ? null : Number(t.nav), folio: t.folio_number,
  }));
  // A purchase the same CAS shows rejected / reversed within 15 days executed nothing: never matched to a call.
  const gone = bouncedPurchases(all, (a, b) => (a.securityId ?? a.isin) === (b.securityId ?? b.isin) && (a.folio ?? "") === (b.folio ?? ""));
  const txns = all.filter((t) => !gone.has(t));
  return { txns, folioOf: new Map(txnRows.map((t) => [t.id, t.folio_number])) };
}

/**
 * Many SIPs (placed through brokers and platforms) show in the CAS only as a
 * plain "Purchase" repeating every month. A purchase in such a run (the same
 * rule as the SIP tab: 3+ of the same amount about a month apart, over the
 * client's whole history) is a SIP instalment, not a trade to decide: unless a
 * Buy call on that fund is open, which it may be executing.
 */
async function markRecurringPurchases(tx: Tx, clientId: string, txns: MatchTxn[], calls: MatchCall[]): Promise<MatchTxn[]> {
  const buys = txns.filter((t) => t.type === "PURCHASE" && (t.amount ?? 0) > 0);
  if (!buys.length) return txns;
  // A Buy call still open, or done by hand but not yet seen in a CAS, may be what this purchase executes.
  const openBuy = new Set(calls.filter((c) => c.action === "BUY" && (c.status !== "EXECUTED" || c.unverifiedExecutedAmount > 0)).flatMap((c) => [c.securityId, c.isin].filter(Boolean) as string[]));
  // The SIP instalments of the client's whole history (one rule: v_sip_instalments).
  const inRun = new Set((await tx<{ id: string }[]>`
    select transaction_id as id from public.v_sip_instalments where client_id = ${clientId}`).map((r) => r.id));
  // In a run and no Buy call open on the fund: a SIP instalment. With a Buy call open it may be either: matched,
  // but never confirmed without a person.
  return txns.map((t) => (t.type !== "PURCHASE" || !inRun.has(t.id) ? t
    : !openBuy.has(t.securityId ?? "") && !openBuy.has(t.isin ?? "") ? { ...t, type: "SIP" }
    : { ...t, recurring: true }));
}

const needsPerson = (p: TxnProposal) => (p.kind === "ADVICE_MATCH" && !p.autoConfirm) || p.kind === "UNADVISED";

/** Writes the proposals into a run; clear matches are confirmed right away. */
async function saveTxnProposals(
  tx: Tx, actor: Actor | null, runId: string, clientId: string, proposals: TxnProposal[], folioOf: Map<string, string | null>,
): Promise<void> {
  const toConfirm: string[] = [];
  const outside = await outsideFunds(tx, clientId);
  for (const p of proposals) {
    if (p.kind === "SIP_CANCELLED") continue; // no units moved; handled via SIP plan items
    // A fund outside the advised portfolio (onboarded with the report as it is): noted, not a trade to decide.
    const isOutside = isOutsideTrade(p, outside);
    const sign = p.direction === "SELL" ? -1 : 1;
    const classification = p.kind === "ADVICE_MATCH" ? "ADVICE_MATCH" : p.kind === "SIP_INSTALMENT" ? "SIP_INSTALMENT" : "UNADVISED";
    const status = p.kind === "ADVICE_MATCH" ? "SUGGESTED" : "UNEXPLAINED";
    const ins = await tx<{ id: string }[]>`
      insert into public.reconciliation_matches
        (run_id, client_id, advice_item_id, security_id, scheme_name, folio_numbers, change_type, classification,
         detected_change, approx_amount, reference_nav, expected_amount, allocated_units, confidence, status,
         system_note, reviewed_at, cas_transaction_id, transaction_date, transaction_amount, transaction_units,
         transaction_nav, auto_confirmed)
      values (${runId}, ${clientId}, ${p.callId}, ${p.securityId}, ${p.schemeName},
              ${folioOf.get(p.txnId) ? [folioOf.get(p.txnId) as string] : []},
              ${sign < 0 ? "DECREASE" : "INCREASE"}, ${classification}, ${sign * p.txnUnits}, ${p.allocatedAmount},
              ${p.nav}, ${p.expectedAmount}, ${p.allocatedUnits}, ${p.confidence}, ${status}, ${p.note},
              ${p.kind === "SIP_INSTALMENT" || isOutside ? new Date() : null}, ${p.txnId}, ${p.date}, ${p.txnAmount}, ${p.txnUnits},
              ${p.nav}, ${p.kind === "ADVICE_MATCH" && p.autoConfirm})
      returning id`;
    if (isOutside) {
      await setAuditReason(tx, OUTSIDE_ADVISED);
      await tx`update public.reconciliation_matches set resolution_note = ${OUTSIDE_ADVISED} where id = ${ins[0].id}`;
    }
    if (p.kind === "ADVICE_MATCH" && p.autoConfirm) toConfirm.push(ins[0].id);
  }
  // Each auto-confirm runs in its own savepoint: one that cannot be confirmed stays SUGGESTED for a person,
  // instead of failing the whole CAS upload.
  for (const id of toConfirm) {
    try {
      await (tx as unknown as { savepoint: <T>(cb: (sp: Tx) => Promise<T>) => Promise<T> }).savepoint((sp) => resolveMatch(sp, actor, id, "CONFIRM", { auto: true }));
    } catch (e) {
      const why = e instanceof AppError ? e.message : "it could not be confirmed automatically";
      if (!(e instanceof AppError)) logServerError("reconciliation.autoConfirm", e);
      await tx`update public.reconciliation_matches set auto_confirmed = false,
                 system_note = left(concat_ws(' · ', system_note, ${`Not auto-confirmed: ${why}`}), 1000)
               where id = ${id}`;
      // It now needs a person: the run stays open (and shows on the inbox) until they resolve it.
      await tx`update public.reconciliation_runs
               set status = 'OPEN', completed_at = null,
                   summary = summary || jsonb_build_object(
                     'auto_confirmed', greatest(coalesce((summary->>'auto_confirmed')::int, 0) - 1, 0),
                     'needs_review', coalesce((summary->>'needs_review')::int, 0) + 1)
               where id = ${runId} and status in ('OPEN', 'COMPLETED')`;
    }
  }
}

async function runTransactionReconciliation(
  tx: Tx,
  actor: Actor | null,
  args: {
    clientId: string;
    previous: { id: string; snapshot_date: string; total_current_value: number };
    current: { id: string; snapshot_date: string; total_current_value: number };
  },
): Promise<{ runId: string; existing: boolean }> {
  const { calls, switchTargets } = await loadMatchCalls(tx, args.clientId);
  const loaded = await loadSnapshotTxns(tx, args.current.id, args.previous.snapshot_date);
  const folioOf = loaded.folioOf;
  const txns = await markRecurringPurchases(tx, args.clientId, loaded.txns, calls);

  const proposals = matchTransactions(calls, txns, switchTargets);
  const sipItemsCompleted = await completeSipItemsFromTransactions(tx, args.clientId, proposals);

  const summary: TxnRunSummary = {
    transactions: new Set(proposals.map((p) => p.txnId)).size,
    advice_matches: proposals.filter((p) => p.kind === "ADVICE_MATCH").length,
    auto_confirmed: proposals.filter((p) => p.kind === "ADVICE_MATCH" && p.autoConfirm).length,
    needs_review: proposals.filter((p) => p.kind === "ADVICE_MATCH" && !p.autoConfirm).length,
    unadvised: proposals.filter((p) => p.kind === "UNADVISED").length,
    sip_instalments: proposals.filter((p) => p.kind === "SIP_INSTALMENT").length,
    sip_cancellations: proposals.filter((p) => p.kind === "SIP_CANCELLED").length,
    sip_items_completed: sipItemsCompleted,
  };

  const outside = await outsideFunds(tx, args.clientId);
  const open = proposals.some((p) => needsPerson(p) && !isOutsideTrade(p, outside));
  const run = await tx<{ id: string }[]>`
    insert into public.reconciliation_runs (client_id, previous_snapshot_id, current_snapshot_id, previous_value, current_value,
                                            summary, engine_version, status, completed_at, created_by)
    values (${args.clientId}, ${args.previous.id}, ${args.current.id}, ${args.previous.total_current_value},
            ${args.current.total_current_value}, ${tx.json(summary as unknown as Record<string, number>)}, ${TXN_ENGINE_VERSION},
            ${open ? "OPEN" : "COMPLETED"}, ${open ? null : new Date()}, ${actor?.id ?? null})
    returning id`;

  await saveTxnProposals(tx, actor, run[0].id, args.clientId, proposals, folioOf);
  return { runId: run[0].id, existing: false };
}

/**
 * Re-check a CAS: match the transactions of the run's CAS that have no row in
 * the run yet (e.g. ones an older reader did not recognise, or calls recorded
 * since). Rows already in the run, and anything already confirmed, stay.
 */
export async function recheckRun(tx: Tx, actor: Actor | null, runId: string): Promise<{ added: number; needsReview: number; closedHistory: number }> {
  const run = (await tx<{ client_id: string; current_snapshot_id: string; status: string; engine_version: string; previous_date: string }[]>`
    select r.client_id, r.current_snapshot_id, r.status, r.engine_version, ps.snapshot_date::text as previous_date
    from public.reconciliation_runs r join public.portfolio_snapshots ps on ps.id = r.previous_snapshot_id
    where r.id = ${runId} for update of r`)[0];
  if (!run) throw new AppError("Reconciliation run not found.", "NOT_FOUND");
  if (run.status === "CANCELLED") throw new AppError("This reconciliation run was cancelled.");
  if (run.engine_version !== TXN_ENGINE_VERSION) throw new AppError("Only a CAS with transactions can be re-checked.");

  // Rows for trades on or before the previous CAS (older engine) are history: close them.
  await setAuditReason(tx, "CAS re-checked: trades before the previous CAS are history");
  const closed = await tx`
    update public.reconciliation_matches set status = 'REJECTED', resolved_at = now(), resolved_by = ${actor?.id ?? null},
      reviewed_at = coalesce(reviewed_at, now()), reviewed_by = coalesce(reviewed_by, ${actor?.id ?? null}),
      resolution_note = ${HISTORY_BEFORE_PREVIOUS_CAS} || coalesce(E'\n' || resolution_note, '')
    where run_id = ${runId} and transaction_date <= ${run.previous_date}::date
      and classification in ('UNADVISED', 'SIP_INSTALMENT') and status in ('UNEXPLAINED', 'SUGGESTED')`;

  const { calls, switchTargets } = await loadMatchCalls(tx, run.client_id);
  // Cancelling a call recorded from a SIP instalment is an adviser's change (Operations may still re-check).
  if (actor && actor.role !== "OPERATIONS") await settleSipInstalments(tx, actor, { runId });
  const loaded = await loadSnapshotTxns(tx, run.current_snapshot_id, run.previous_date, runId);
  const folioOf = loaded.folioOf;
  const txns = await markRecurringPurchases(tx, run.client_id, loaded.txns, calls);
  const proposals = matchTransactions(calls, txns, switchTargets).filter((p) => p.kind !== "SIP_CANCELLED");
  if (!proposals.length) {
    if (closed.count) await closeRunIfDone(tx, runId);
    return { added: 0, needsReview: 0, closedHistory: closed.count };
  }

  await completeSipItemsFromTransactions(tx, run.client_id, proposals);
  const outsideIds = await outsideFunds(tx, run.client_id);
  const needsReview = proposals.filter((p) => needsPerson(p) && !isOutsideTrade(p, outsideIds)).length;
  if (needsReview > 0) {
    await setAuditReason(tx, "CAS re-checked: new transactions to review");
    await tx`update public.reconciliation_runs set status = 'OPEN', completed_at = null where id = ${runId} and status <> 'OPEN'`;
  }
  await saveTxnProposals(tx, actor, runId, run.client_id, proposals, folioOf);
  if (needsReview === 0) await closeRunIfDone(tx, runId);
  return { added: proposals.length, needsReview, closedHistory: closed.count };
}

/** Resolution note of rows closed because the trade predates the previous CAS. */
export const HISTORY_BEFORE_PREVIOUS_CAS = "History: dated on or before the previous CAS, not a change";

/** Close the run once nothing needs a decision any more. */
async function closeRunIfDone(tx: Tx, runId: string): Promise<void> {
  await tx`
    update public.reconciliation_runs r set status = 'COMPLETED', completed_at = now()
    where r.id = ${runId} and r.status = 'OPEN'
      and not exists (
        select 1 from public.reconciliation_matches x
        where x.run_id = r.id and (x.status = 'SUGGESTED' or (x.status = 'UNEXPLAINED' and x.reviewed_at is null)))`;
}

/**
 * SIP instalments tick off START / CHANGE plan items (new amount seen on or
 * after the plan was approved); "SIP Cancelled" ticks off STOP items.
 */
async function completeSipItemsFromTransactions(tx: Tx, clientId: string, proposals: TxnProposal[]): Promise<number> {
  const sipEvents = proposals.filter((p) => (p.kind === "SIP_INSTALMENT" || p.kind === "SIP_CANCELLED") && p.securityId);
  if (sipEvents.length === 0) return 0;
  const items = await tx<{ id: string; security_id: string; action: "START" | "STOP" | "CHANGE"; new_amount: number | null; since: Date | null }[]>`
    select s.id, s.security_id, s.action, s.new_amount,
           -- From the report date when that is earlier: clients often act on the report before approval.
           least(coalesce(s.advised_at, p.approved_at), p.plan_date::timestamptz) as since
    from public.sip_plan_items s
    join public.advisory_plans p on p.id = s.plan_id
    where s.client_id = ${clientId} and p.status = 'ACTIVE' and s.status in ('PLANNED', 'ADVISED')
      and s.security_id is not null`;
  let done = 0;
  for (const item of items) {
    const sinceDate = item.since ? istDate(new Date(item.since)) : "0000-00-00";
    const hit = sipEvents.find((e) => {
      if (e.securityId !== item.security_id || e.date < sinceDate) return false;
      if (item.action === "STOP") return e.kind === "SIP_CANCELLED";
      if (e.kind !== "SIP_INSTALMENT") return false;
      if (item.action === "CHANGE" && item.new_amount) return Math.abs(e.txnAmount - Number(item.new_amount)) <= Number(item.new_amount) * 0.05 + 1;
      return true;
    });
    if (!hit) continue;
    await setAuditReason(tx, `SIP ${item.action.toLowerCase()} seen in CAS on ${hit.date}`);
    await tx`
      update public.sip_plan_items set status = 'COMPLETED', completed_at = coalesce(completed_at, now()),
        notes = coalesce(notes || E'\n', '') || ${`Verified from CAS: ${hit.note}`}
      where id = ${item.id}`;
    done++;
  }
  return done;
}

export async function cancelRun(tx: Tx, runId: string, reason: string): Promise<void> {
  if (!reason.trim()) throw new AppError("A reason is required.");
  const resolved = await tx<{ n: number }[]>`
    select count(*)::int as n from public.reconciliation_matches where run_id = ${runId} and status in ('CONFIRMED', 'PARTIAL')`;
  if (resolved[0].n > 0) throw new AppError("This run already has confirmed matches and cannot be cancelled.");
  await setAuditReason(tx, reason);
  const res = await tx`update public.reconciliation_runs set status = 'CANCELLED', completed_at = now() where id = ${runId} and status = 'OPEN'`;
  if (res.count === 0) throw new AppError("Only an open run can be cancelled.");
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
    select m.*, m.transaction_date::text as transaction_date, a.action as advice_action, a.status as advice_status, b.batch_code as advice_batch_code,
           b.communicated_at as advice_communicated_at, a.advised_amount as advice_advised_amount,
           a.advised_units as advice_advised_units
    from public.reconciliation_matches m
    left join public.advice_items a on a.id = m.advice_item_id
    left join public.advice_batches b on b.id = a.advice_batch_id
    where m.run_id = ${runId}
    order by case m.status when 'SUGGESTED' then 0 when 'UNEXPLAINED' then 1 else 2 end,
             m.scheme_name, b.communicated_at nulls last`;
}

// -----------------------------------------------------------------------------
// Resolution (human decisions)
// -----------------------------------------------------------------------------
export type MatchDecision = "CONFIRM" | "PARTIAL" | "REJECT" | "UNADVISED" | "ACKNOWLEDGE";

export async function resolveMatch(
  tx: Tx,
  actor: Actor | null,
  matchId: string,
  decision: MatchDecision,
  opts: { units?: number | null; amount?: number | null; note?: string | null; auto?: boolean } = {},
): Promise<{ executionId: string | null; verifiedExecutions: number }> {
  const rows = await tx<(ReconciliationMatchRow & { run_status: string; current_snapshot_date: string })[]>`
    select m.*, m.transaction_date::text as transaction_date, r.status as run_status, cs.snapshot_date as current_snapshot_date
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
    // A cancelled, expired or revised call takes no more executions.
    const call = (await tx<{ status: string }[]>`select status from public.advice_items where id = ${m.advice_item_id}`)[0];
    if (!call || !["ISSUED", "PARTIALLY_EXECUTED", "EXECUTED"].includes(call.status)) {
      throw new AppError(`This call is ${call ? call.status.toLowerCase() : "gone"}: reject the match, or mark the trade as the client's own.`);
    }
    const nav = Number(m.reference_nav ?? 0);
    const fromTxn = m.cas_transaction_id !== null;
    const units = decision === "PARTIAL" ? Number(opts.units) : Number(m.allocated_units ?? Math.abs(m.detected_change));
    if (!(units > 0)) throw new AppError("Enter the units that belong to this call.");
    if (units > Math.abs(Number(m.detected_change)) + 0.001) throw new AppError("Confirmed units cannot exceed the detected change.");
    // Transaction-level matches carry the exact rupee amount from the CAS.
    const amount = decision === "PARTIAL" && opts.amount
      ? Number(opts.amount)
      : fromTxn && decision === "CONFIRM" ? Number(m.approx_amount) : round2(units * nav);
    if (!(amount > 0)) throw new AppError("Enter the rupee amount for this execution.");
    if (fromTxn && m.transaction_amount != null && amount > Math.abs(Number(m.transaction_amount)) * (1 + VERIFY_TOLERANCE) + 1) {
      throw new AppError("The amount cannot be more than the CAS transaction.");
    }
    if (decision === "PARTIAL" && !note) throw new AppError("Add a note explaining the partial match.");

    await setAuditReason(tx, note ?? (opts.auto
      ? "Auto-confirmed: CAS transaction clearly matches the call"
      : `Reconciliation match confirmed (${decision})`));

    // 1) Executions already recorded by hand are VERIFIED, not duplicated. Verification is cumulative:
    //    several CAS trades (e.g. two redemptions) can together verify one hand-recorded execution, so
    //    this trade first uses up whatever hand-recorded amount earlier confirmed trades left uncovered.
    const hand = await tx<{ id: string; executed_amount: number; verified: boolean }[]>`
      select id, executed_amount::float8 as executed_amount, cas_verified_at is not null as verified from public.executions
      where advice_item_id = ${m.advice_item_id} and status in ('EXECUTED', 'PARTIAL') and verification_type <> 'CAS_VERIFIED'
      order by execution_date, created_at`;
    const handTotal = hand.reduce((t, e) => t + e.executed_amount, 0);
    // What earlier confirmed trades on this call already counted against hand-recorded executions
    // (their confirmed amount less the CAS execution each one created).
    const priorCover = Number((await tx<{ v: number }[]>`
      select coalesce(sum(greatest(coalesce(m2.confirmed_amount, 0) - coalesce(e.executed_amount, 0), 0)), 0)::float8 as v
      from public.reconciliation_matches m2 left join public.executions e on e.id = m2.execution_id
      where m2.advice_item_id = ${m.advice_item_id} and m2.id <> ${m.id} and m2.status in ('CONFIRMED', 'PARTIAL')`)[0].v);
    const handLeft = Math.max(handTotal - priorCover, 0);
    const slack = Math.max(1, amount * VERIFY_TOLERANCE);
    // NAV drift: a hand amount within tolerance of this trade counts as the same money.
    const cover = handLeft >= amount - slack ? amount : handLeft;
    const coveredSoFar = priorCover + cover;
    let running = 0;
    for (const e of hand) {
      running += e.executed_amount;
      if (running > coveredSoFar * (1 + VERIFY_TOLERANCE) + 1) break;
      if (e.verified) continue;
      await tx`update public.executions set cas_verified_at = now(), cas_verification_match_id = ${m.id} where id = ${e.id}`;
      verified++;
    }

    // 2) The rest becomes a new CAS_VERIFIED execution.
    let remainingAmount = round2(amount - cover);
    if (remainingAmount <= slack) remainingAmount = 0;
    if (call.status === "EXECUTED" && remainingAmount > 0) {
      // Already fully done: only hand-recorded executions are left to verify, never a second execution.
      throw new AppError("This call is already fully executed: this trade is more than the part still to verify. Reject the match, or mark it as the client's own.");
    }
    if (remainingAmount > 0) {
      const lastTxn = fromTxn ? [{ d: m.transaction_date }] : await tx<{ d: string | null }[]>`
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
                ${`${opts.auto ? "Auto-verified" : "Verified"} from CAS${fromTxn ? ` transaction of ${m.transaction_date}` : " reconciliation"}${note ? `: ${note}` : ""}`},
                now(), ${m.id}, ${actor?.id ?? null})
        returning id`;
      executionId = ins[0].id;
    }

    await tx`
      update public.reconciliation_matches set
        status = ${decision === "CONFIRM" ? "CONFIRMED" : "PARTIAL"}, confirmed_units = ${units}, confirmed_amount = ${amount},
        execution_id = ${executionId}, resolution_note = ${note ?? (opts.auto ? "Auto-confirmed" : null)}, resolved_at = now(),
        resolved_by = ${actor?.id ?? null}
      where id = ${m.id}`;
  } else if (decision === "REJECT") {
    if (m.status !== "SUGGESTED") throw new AppError(`Match is already ${m.status}.`);
    if (!note) throw new AppError("Add a note explaining why this match is rejected.");
    await setAuditReason(tx, note);
    await tx`
      update public.reconciliation_matches set status = 'REJECTED', resolution_note = ${note}, resolved_at = now(), resolved_by = ${actor?.id ?? null}
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
      update public.reconciliation_matches set reviewed_at = now(), reviewed_by = ${actor?.id ?? null},
        resolution_note = coalesce(resolution_note || E'\n', '') || ${note}
      where id = ${m.id}`;
  }

  await closeRunIfDone(tx, m.run_id);

  return { executionId, verifiedExecutions: verified };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

// -----------------------------------------------------------------------------
// "This was advised": a CAS trade flagged unadvised because the call was given
// outside the dashboard (phone / WhatsApp before it was logged).
// -----------------------------------------------------------------------------
/**
 * Records the call (linked to the matching ACTIVE plan line when there is one,
 * communicated on or before the trade) and confirms the CAS trade as its
 * execution. The original unadvised row is closed with a note; a new matched
 * row carries the link, so resolved history is never rewritten.
 */
/** Resolution note prefix of an unadvised row recorded as advised. */
export const RECORDED_AS_ADVISED = "Recorded as advised";

export async function recordAdvisedOffline(
  tx: Tx,
  actor: Actor,
  matchId: string,
  opts: { communicatedAt?: Date | null; channel: Channel; note?: string | null },
): Promise<{ adviceItemId: string; executionId: string | null; planItemId: string | null }> {
  const m = (await tx<(ReconciliationMatchRow & { run_status: string })[]>`
    select m.*, m.transaction_date::text as transaction_date, r.status as run_status
    from public.reconciliation_matches m join public.reconciliation_runs r on r.id = m.run_id
    where m.id = ${matchId} for update of m`)[0];
  if (!m) throw new AppError("Match not found.", "NOT_FOUND");
  if (m.run_status === "CANCELLED") throw new AppError("This reconciliation run was cancelled.");
  const sipWorded = m.cas_transaction_id ? (await tx<{ t: string }[]>`
    select public.txn_effective_type(transaction_type, description, units) as t from public.portfolio_transactions where id = ${m.cas_transaction_id}`)[0]?.t === "SIP" : false;
  if (sipWorded) throw new AppError("This is a SIP instalment (the CAS words it as SIP / systematic), not a lump-sum trade: it is not recorded as a call.");
  if (m.classification !== "UNADVISED" || !["UNEXPLAINED", "SUGGESTED"].includes(m.status)) {
    throw new AppError("Only an unadvised CAS trade can be recorded as advised.");
  }
  if (!m.cas_transaction_id || !m.security_id || !m.transaction_date || !(Number(m.transaction_amount) > 0)) {
    throw new AppError("This change has no single CAS transaction to record.");
  }
  const action: "BUY" | "SELL" = m.change_type === "DECREASE" ? "SELL" : "BUY";
  // The row may be only the part of the trade that open calls did not cover.
  const amount = Number(m.approx_amount) > 0 ? Number(m.approx_amount) : Number(m.transaction_amount);
  const units = m.allocated_units != null ? Number(m.allocated_units) : m.transaction_units;

  // The call cannot be later than the trade it explains.
  const tradeDay = new Date(`${m.transaction_date}T09:00:00+05:30`);
  const at = opts.communicatedAt ?? tradeDay;
  if (at.getTime() > new Date(`${m.transaction_date}T23:59:59+05:30`).getTime()) {
    throw new AppError(`The call must have been given on or before the trade (${m.transaction_date}).`);
  }


  await setAuditReason(tx, opts.note?.trim() || "Call given outside the dashboard; recorded from the CAS trade");
  const b = await issueAdvice(tx, actor, {
    clientId: m.client_id,
    communicatedAt: at,
    channel: opts.channel,
    notes: `Recorded after the trade: advised outside the dashboard${opts.note ? ` (${opts.note})` : ""}`,
    items: [{
      security_id: m.security_id,
      scheme_name: m.scheme_name,
      folio_number: m.folio_numbers?.[0] ?? null,
      action,
      quantity_basis: "AMOUNT",
      advised_amount: amount,
    }],
  });
  const adviceItemId = b.itemIds[0];

  const ins = await tx<{ id: string }[]>`
    insert into public.reconciliation_matches
      (run_id, client_id, security_id, scheme_name, folio_numbers, change_type, previous_units, current_units, detected_change,
       previous_value, current_value, reference_nav, approx_amount, advice_item_id, classification, expected_amount,
       allocated_units, confidence, status, system_note, cas_transaction_id, transaction_date, transaction_amount,
       transaction_units, transaction_nav)
    values (${m.run_id}, ${m.client_id}, ${m.security_id}, ${m.scheme_name}, ${m.folio_numbers ?? []}, ${m.change_type},
            ${m.previous_units}, ${m.current_units}, ${m.detected_change}, ${m.previous_value}, ${m.current_value},
            ${m.reference_nav}, ${amount}, ${adviceItemId}, 'ADVICE_MATCH', ${amount},
            ${units}, 'HIGH', 'SUGGESTED', 'Call recorded after the trade (advised outside the dashboard).',
            ${m.cas_transaction_id}, ${m.transaction_date}::date, ${m.transaction_amount}, ${m.transaction_units}, ${m.transaction_nav})
    returning id`;
  // Close the original row first, so confirming the new one can close the run.
  await tx`
    update public.reconciliation_matches set
      status = 'REJECTED', resolved_at = now(), resolved_by = ${actor.id},
      reviewed_at = coalesce(reviewed_at, now()), reviewed_by = coalesce(reviewed_by, ${actor.id}),
      resolution_note = ${`${RECORDED_AS_ADVISED} (call ${b.batchCode})${opts.note ? `: ${opts.note}` : ""}`}
    where id = ${m.id}`;
  const res = await resolveMatch(tx, actor, ins[0].id, "CONFIRM", { note: opts.note ?? "Advised outside the dashboard" });
  // issueAdvice put the call on the fund's Buy / Sell line (adding or converting one when needed).
  const planItemId = (await tx<{ plan_item_id: string | null }[]>`select plan_item_id from public.advice_items where id = ${adviceItemId}`)[0]?.plan_item_id ?? null;
  return { adviceItemId, executionId: res.executionId, planItemId };
}

// -----------------------------------------------------------------------------
// SIP instalments read as trades by an older reader
// -----------------------------------------------------------------------------
export const SIP_NOT_A_TRADE = "SIP instalment: the CAS words it as a systematic / SIP purchase, so it is not a trade to decide";
const OFFLINE_CALL_NOTE = "Recorded after the trade";

/**
 * Rows of SIP instalments that an older reader left as unadvised trades become
 * SIP instalments again. Where someone recorded one as "We advised it", the
 * call and its execution made from it are cancelled (with the reason in the
 * audit log): a SIP instalment is not a lump-sum buy call. Calls given in the
 * dashboard are never touched.
 */
export async function settleSipInstalments(
  tx: Tx, actor: Actor | null, scope: { runId?: string; clientId?: string } = {},
): Promise<{ reclassified: number; callsCancelled: number }> {
  const rows = await tx<{ id: string; run_id: string; status: string; reviewed: boolean; resolution_note: string | null; cas_transaction_id: string }[]>`
    select m.id, m.run_id, m.status, m.reviewed_at is not null as reviewed, m.resolution_note, m.cas_transaction_id
    from public.reconciliation_matches m
    join public.reconciliation_runs r on r.id = m.run_id and r.status <> 'CANCELLED'
    join public.portfolio_transactions t on t.id = m.cas_transaction_id
    where m.classification = 'UNADVISED'
      and public.txn_effective_type(t.transaction_type, t.description, t.units) = 'SIP'
      and (${scope.runId ?? null}::uuid is null or m.run_id = ${scope.runId ?? null})
      and (${scope.clientId ?? null}::uuid is null or m.client_id = ${scope.clientId ?? null})
      and ((m.status in ('UNEXPLAINED', 'SUGGESTED') and m.reviewed_at is null)
           or (m.status = 'REJECTED' and m.resolution_note like ${`${RECORDED_AS_ADVISED}%`}))`;
  let reclassified = 0;
  let callsCancelled = 0;
  for (const r of rows) {
    if (r.status === "REJECTED") {
      // The call recorded from this instalment ("We advised it"), and the match that confirmed it.
      const made = await tx<{ match_id: string; advice_item_id: string }[]>`
        select am.id as match_id, am.advice_item_id
        from public.reconciliation_matches am
        join public.advice_items ai on ai.id = am.advice_item_id
        join public.advice_batches b on b.id = ai.advice_batch_id
        where am.run_id = ${r.run_id} and am.cas_transaction_id = ${r.cas_transaction_id} and am.classification = 'ADVICE_MATCH'
          and am.status in ('CONFIRMED', 'PARTIAL') and b.notes like ${`${OFFLINE_CALL_NOTE}%`}`;
      for (const a of made) {
        const execs = await tx<{ id: string }[]>`
          select id from public.executions where advice_item_id = ${a.advice_item_id} and status not in ('REJECTED', 'CANCELLED')`;
        for (const e of execs) await voidExecution(tx, e.id, "CANCELLED", SIP_NOT_A_TRADE);
        const open = (await tx<{ open: boolean }[]>`select is_open as open from public.v_advice_items where id = ${a.advice_item_id}`)[0]?.open;
        if (open) await closeAdvice(tx, a.advice_item_id, "CANCELLED", SIP_NOT_A_TRADE);
        // A resolved match stays resolved (database rule); its call and execution are cancelled above.
        await setAuditReason(tx, SIP_NOT_A_TRADE);
        await tx`
          update public.reconciliation_matches set resolution_note = coalesce(resolution_note || E'\n', '') || ${"Undone: " + SIP_NOT_A_TRADE}
          where id = ${a.match_id}`;
        callsCancelled++;
      }
    }
    await setAuditReason(tx, SIP_NOT_A_TRADE);
    await tx`
      update public.reconciliation_matches set classification = 'SIP_INSTALMENT',
        status = case when status = 'SUGGESTED' then 'UNEXPLAINED' else status end,
        reviewed_at = coalesce(reviewed_at, now()), reviewed_by = coalesce(reviewed_by, ${actor?.id ?? null}),
        system_note = ${SIP_NOT_A_TRADE}, resolution_note = case when resolution_note is null then null else resolution_note || E'\n' || ${"Undone: " + SIP_NOT_A_TRADE} end
      where id = ${r.id}`;
    reclassified++;
    await closeRunIfDone(tx, r.run_id);
  }
  return { reclassified, callsCancelled };
}

// -----------------------------------------------------------------------------
// Funds outside the advised portfolio ("onboard with the report as it is")
// -----------------------------------------------------------------------------
export const OUTSIDE_ADVISED = "Outside the advised portfolio: the report this client was onboarded with does not cover this fund";

/** A trade no call explains, in a fund outside the advised portfolio: noted, never a decision. */
export const isOutsideTrade = (p: { kind: string; securityId: string | null }, outside: Set<string>) =>
  p.kind === "UNADVISED" && p.securityId !== null && outside.has(p.securityId);

/** Security ids of the CAS funds the client's active / draft plan leaves outside the advised portfolio. */
export async function outsideFunds(tx: Tx, clientId: string): Promise<Set<string>> {
  const rows = await tx<{ id: string }[]>`
    select distinct sm.id
    from public.advisory_plans p
    cross join lateral jsonb_array_elements(coalesce(p.as_reported->'outside', '[]'::jsonb)) o
    join public.security_master sm on sm.isin = o->>'isin'
    where p.client_id = ${clientId} and p.status in ('ACTIVE', 'DRAFT')`;
  return new Set(rows.map((r) => r.id));
}
