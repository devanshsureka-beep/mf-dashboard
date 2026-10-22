/**
 * Approve waiting: a person marks many waiting calls and SIP lines of one client as done, part
 * done, revised or cancelled in one go, before any CAS shows them. Done here is an execution
 * recorded by hand (ADVISOR_CONFIRMED); the next CAS that shows the trade verifies that same
 * execution (reconciliation never counts it twice), and v_client_bank counts it in the money
 * until then ("approved, waiting for CAS").
 */
import type { Actor, Tx } from "@/lib/db/tx";
import { setAuditReason } from "@/lib/db/tx";
import { AppError } from "@/lib/errors";
import { APPROVED_NOTE, callOp, LineError, sipOp, type LineInput } from "@/lib/domain/waiting-approve";
import { closeAdvice, getAdviceItem, reviseAdvice } from "./advice";
import { recordExecution, voidExecution } from "./executions";
import { setSipStatus } from "./plans";
import { listWaiting, type WaitingCall } from "./waiting";

export interface WaitingSip {
  id: string; scheme_name: string; action: "START" | "STOP" | "CHANGE"; old_amount: number | null; new_amount: number | null;
  advised_at: string | null; status: string;
}

export interface ApprovedRow {
  kind: "CALL" | "SIP";
  /** Execution id (CALL) or SIP line id (SIP): what Undo works on. */
  id: string;
  advice_item_id: string | null;
  scheme_name: string;
  action: string;
  amount: number | null;
  units: number | null;
  date: string | null;
  /** Revised or cancelled lines are history, not undoable here. */
  undoable: boolean;
}

export interface Approvable {
  calls: WaitingCall[];
  sips: WaitingSip[];
  /** Approved by a person, not in any CAS yet. */
  approved: ApprovedRow[];
}

export async function getApprovable(tx: Tx, clientId: string): Promise<Approvable> {
  const calls = (await listWaiting(tx, { clientId })).filter((c) => c.pending_amount >= 0.5 || Number(c.pending_units ?? 0) > 0.0001);
  const sips = await tx<WaitingSip[]>`
    select s.id, s.scheme_name, s.action, s.old_amount::float8 as old_amount, s.new_amount::float8 as new_amount,
           (s.advised_at at time zone 'Asia/Kolkata')::date::text as advised_at, s.status
    -- Same lines as the Tranches & SIPs ledger: any approved plan's advised SIP line still waits.
    from public.sip_plan_items s join public.advisory_plans p on p.id = s.plan_id and p.status in ('ACTIVE', 'COMPLETED', 'REPLACED')
    where s.client_id = ${clientId} and s.status = 'ADVISED'
    order by s.advised_at nulls last, s.scheme_name`;
  const execs = await tx<ApprovedRow[]>`
    select 'CALL' as kind, e.id, e.advice_item_id, ai.scheme_name, ai.action, e.executed_amount::float8 as amount,
           e.executed_units::float8 as units, e.execution_date::text as date, true as undoable
    from public.executions e join public.advice_items ai on ai.id = e.advice_item_id
    left join lateral (
      select l.snapshot_date, coalesce(ps.reviewed_at, ps.created_at) as current_from
      from public.v_latest_snapshot l join public.portfolio_snapshots ps on ps.id = l.snapshot_id
      where l.client_id = e.client_id) ls on true
    where e.client_id = ${clientId} and e.status in ('EXECUTED', 'PARTIAL')
      and e.verification_type in ('CLIENT_CONFIRMED', 'ADVISOR_CONFIRMED') and e.cas_verified_at is null
      -- Same rule as v_client_bank (0048): not yet in the CAS figures.
      and (ls.snapshot_date is null or e.execution_date >= ls.snapshot_date or e.created_at < ls.current_from)
    order by e.execution_date desc, e.created_at desc`;
  const sipDone = await tx<ApprovedRow[]>`
    select 'SIP' as kind, s.id, null as advice_item_id, s.scheme_name, s.action, s.new_amount::float8 as amount, null::float8 as units,
           (s.completed_at at time zone 'Asia/Kolkata')::date::text as date, true as undoable
    from public.sip_plan_items s join public.advisory_plans p on p.id = s.plan_id and p.status in ('ACTIVE', 'COMPLETED', 'REPLACED')
    where s.client_id = ${clientId} and s.status = 'COMPLETED'
      and coalesce(s.notes, '') like ${`%${APPROVED_NOTE}%`} and coalesce(s.notes, '') not like '%Verified from CAS%'
    order by s.completed_at desc`;
  return { calls, sips, approved: [...execs, ...sipDone] };
}

export interface ApproveLine extends LineInput {
  kind: "CALL" | "SIP";
  id: string;
}

/** One ticked line. Throws AppError with a plain message the page shows on that line. */
export async function approveLine(tx: Tx, actor: Actor, clientId: string, line: ApproveLine, today: string): Promise<string> {
  try {
    if (line.kind === "SIP") {
      const [s] = await tx<{ client_id: string; status: string; plan_status: string }[]>`
        select s.client_id, s.status, p.status as plan_status from public.sip_plan_items s join public.advisory_plans p on p.id = s.plan_id
        where s.id = ${line.id}`;
      if (!s || s.client_id !== clientId) throw new AppError("That SIP line is not this client's.", "NOT_FOUND");
      if (s.status !== "ADVISED" || !["ACTIVE", "COMPLETED", "REPLACED"].includes(s.plan_status)) throw new AppError("This SIP line is no longer waiting.");
      const op = sipOp(line, today);
      if (op.op === "SIP_STARTED") {
        await setSipStatus(tx, line.id, "COMPLETED", `${APPROVED_NOTE} (started ${op.date})`);
        return "SIP started";
      }
      await setSipStatus(tx, line.id, "CANCELLED", `Cancelled on the waiting page: ${op.reason}`);
      return "SIP cancelled";
    }

    const a = await getAdviceItem(tx, line.id);
    if (a.client_id !== clientId) throw new AppError("That call is not this client's.", "NOT_FOUND");
    if (!a.is_open) throw new AppError(`This call is no longer waiting (${a.status.toLowerCase().replace("_", " ")}).`);
    const op = callOp({
      quantityBasis: a.quantity_basis, advisedAmount: Number(a.advised_amount), advisedUnits: a.advised_units == null ? null : Number(a.advised_units),
      executedAmount: Number(a.executed_amount), executedUnits: Number(a.executed_units),
      pendingAmount: Number(a.pending_amount), pendingUnits: a.pending_units == null ? null : Number(a.pending_units),
    }, line, today);
    if (op.op === "EXECUTE") {
      const [given] = await tx<{ d: string }[]>`
        select (b.communicated_at at time zone 'Asia/Kolkata')::date::text as d from public.advice_batches b where b.id = ${a.advice_batch_id}`;
      if (given && op.date < given.d) throw new AppError("The date is before the call was given.");
      await setAuditReason(tx, APPROVED_NOTE);
      try {
        await recordExecution(tx, actor, {
          adviceItemId: a.id, executionDate: op.date, executedAmount: op.amount, executedUnits: op.units,
          verificationType: "ADVISOR_CONFIRMED", status: "EXECUTED",
          notes: `${APPROVED_NOTE}${op.partial ? " (part done)" : ""}`,
        });
      } catch (e) {
        // The call page has the "allow over-execution" tick; this page does not.
        if (e instanceof AppError && /over-execution/.test(e.message)) {
          throw new AppError("That is more than 10% above the call. Check the amount, or record it on the call page.");
        }
        throw e;
      }
      return op.partial ? "Part done" : "Done";
    }
    if (op.op === "REVISE") {
      await reviseAdvice(tx, actor, {
        adviceItemId: a.id, newTotalAmount: op.newTotalAmount, newTotalUnits: op.newTotalUnits,
        reason: op.reason, communicatedAt: new Date(), channel: a.communication_channel,
      });
      return "Revised";
    }
    await closeAdvice(tx, a.id, "CANCELLED", `Cancelled on the waiting page: ${op.reason}`);
    return "Cancelled";
  } catch (e) {
    if (e instanceof LineError) throw new AppError(e.message);
    throw e;
  }
}

/** Undo an approval made by hand: the execution is cancelled (kept in history) or the SIP line goes back to waiting. */
export async function undoApproval(tx: Tx, clientId: string, kind: "CALL" | "SIP", id: string): Promise<void> {
  if (kind === "SIP") {
    const [s] = await tx<{ client_id: string; status: string; notes: string | null }[]>`select client_id, status, notes from public.sip_plan_items where id = ${id}`;
    if (!s || s.client_id !== clientId) throw new AppError("That SIP line is not this client's.", "NOT_FOUND");
    if (s.status !== "COMPLETED" || !(s.notes ?? "").includes(APPROVED_NOTE) || (s.notes ?? "").includes("Verified from CAS")) {
      throw new AppError("Only a SIP approved by hand (and not yet shown by a CAS) can be undone.");
    }
    await setSipStatus(tx, id, "ADVISED", "Approval undone: waiting again");
    return;
  }
  const [e] = await tx<{ client_id: string; status: string; verification_type: string; verified: boolean }[]>`
    select client_id, status, verification_type, cas_verified_at is not null as verified from public.executions where id = ${id}`;
  if (!e || e.client_id !== clientId) throw new AppError("That approval is not this client's.", "NOT_FOUND");
  if (e.verification_type === "CAS_VERIFIED" || e.verified) throw new AppError("A CAS already shows this trade: it cannot be undone here.");
  if (!["CLIENT_CONFIRMED", "ADVISOR_CONFIRMED"].includes(e.verification_type)) throw new AppError("Only an approval (client or advisor confirmed) can be undone here.");
  if (!["EXECUTED", "PARTIAL"].includes(e.status)) throw new AppError("This approval is already undone.");
  await voidExecution(tx, id, "CANCELLED", "Approval undone: waiting again");
}

// -----------------------------------------------------------------------------
// CAS inbox: approved vs this CAS
// -----------------------------------------------------------------------------
export interface ApprovedVsCas {
  execution_id: string;
  scheme_name: string;
  action: string;
  amount: number;
  units: number | null;
  date: string;
  /** What the CAS did with it. */
  result: "VERIFIED" | "TO_CONFIRM" | "NOT_IN_CAS";
  cas_amount: number | null;
}

/**
 * Trades approved by hand and dated on or before this CAS: the CAS verified them, a match is waiting
 * for one click, or the CAS does not show them (asked once per CAS: keep waiting / undo approval).
 */
export async function getApprovedVsCas(tx: Tx, clientId: string, casDate: string, runIds: string[]): Promise<ApprovedVsCas[]> {
  return tx<ApprovedVsCas[]>`
    select e.id as execution_id, ai.scheme_name, ai.action, e.executed_amount::float8 as amount, e.executed_units::float8 as units,
           e.execution_date::text as date,
           case when e.cas_verified_at is not null then 'VERIFIED'
                when exists (select 1 from public.reconciliation_matches m join public.reconciliation_runs r on r.id = m.run_id
                             where m.advice_item_id = e.advice_item_id and m.status = 'SUGGESTED' and r.status <> 'CANCELLED') then 'TO_CONFIRM'
                else 'NOT_IN_CAS' end as result,
           (select m.confirmed_amount::float8 from public.reconciliation_matches m where m.id = e.cas_verification_match_id) as cas_amount
    from public.executions e join public.advice_items ai on ai.id = e.advice_item_id
    where e.client_id = ${clientId} and e.status in ('EXECUTED', 'PARTIAL') and e.verification_type in ('CLIENT_CONFIRMED', 'ADVISOR_CONFIRMED')
      and e.execution_date <= ${casDate}::date
      and (
        -- verified by this CAS's matching
        (e.cas_verified_at is not null and exists (
           select 1 from public.reconciliation_matches m where m.id = e.cas_verification_match_id and m.run_id = any(${runIds}::uuid[])))
        -- or still not verified, and nobody chose to keep waiting past this CAS yet
        or (e.cas_verified_at is null and coalesce(e.cas_missing_ack_on, '-infinity'::date) < ${casDate}::date))
    order by e.execution_date, ai.scheme_name`;
}

/** "Keep waiting": the CAS of this date does not show the approved trade; ask again only for a later CAS. */
export async function keepWaiting(tx: Tx, clientId: string, executionId: string, casDate: string): Promise<void> {
  await setAuditReason(tx, `Approved trade not in the CAS of ${casDate}: keep waiting`);
  const res = await tx`
    update public.executions set cas_missing_ack_on = ${casDate}::date
    where id = ${executionId} and client_id = ${clientId} and cas_verified_at is null and verification_type <> 'CAS_VERIFIED'
      and status in ('EXECUTED', 'PARTIAL')`;
  if (res.count === 0) throw new AppError("That approval is not waiting for a CAS.", "NOT_FOUND");
}
