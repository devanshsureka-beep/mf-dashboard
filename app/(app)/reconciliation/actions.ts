"use server";

import { revalidatePath } from "next/cache";
import { num, optStr, reqStr, runAction, type ActionResult } from "@/lib/actions";
import { AppError, logServerError, toUserMessage } from "@/lib/errors";
import { actionTx } from "@/lib/server";
import { cancelRun, recheckRun, recordAdvisedOffline, resolveMatch, type MatchDecision } from "@/services/reconciliation";
import { fromISTDateTimeLocal } from "@/lib/format";
import { CHANNELS, type Channel } from "@/types/domain";

const DECISIONS: MatchDecision[] = ["CONFIRM", "PARTIAL", "REJECT", "UNADVISED", "ACKNOWLEDGE"];

export async function resolveMatchAction(runId: string, matchId: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction("resolveMatch", async () => {
    const decision = reqStr(fd, "decision") as MatchDecision;
    if (!DECISIONS.includes(decision)) throw new AppError("Unknown decision.");
    const out = await actionTx((tx, actor) => resolveMatch(tx, actor, matchId, decision, {
      units: num(fd, "units"), amount: num(fd, "amount"), note: optStr(fd, "note"),
    }));
    revalidatePath(`/reconciliation/${runId}`);
    revalidatePath("/");
    if (decision === "CONFIRM" || decision === "PARTIAL") {
      const parts = [];
      if (out.verifiedExecutions) parts.push(`${out.verifiedExecutions} existing execution(s) marked CAS-verified`);
      if (out.executionId) parts.push("a CAS_VERIFIED execution was created");
      return `Match confirmed: ${parts.join(" and ") || "no additional execution needed"}.`;
    }
    return decision === "REJECT" ? "Match rejected." : decision === "UNADVISED" ? "Marked as unadvised activity." : "Acknowledged.";
  });
}

export async function cancelRunAction(runId: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction("cancelRun", async () => {
    await actionTx((tx) => cancelRun(tx, runId, reqStr(fd, "reason", "Reason")));
    revalidatePath(`/reconciliation/${runId}`);
    return "Run cancelled.";
  });
}

/** "This was advised": the call was given outside the dashboard; record it and confirm the CAS trade as its execution. */
export async function recordAdvisedAction(runId: string, matchId: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction("recordAdvised", async () => {
    const channel = reqStr(fd, "channel", "Channel") as Channel;
    if (!(CHANNELS as readonly string[]).includes(channel)) throw new AppError("Choose how the client was told.");
    const at = optStr(fd, "communicated_at");
    const out = await actionTx((tx, actor) => recordAdvisedOffline(tx, actor, matchId, {
      channel, communicatedAt: at ? fromISTDateTimeLocal(at) : null, note: optStr(fd, "note"),
    }), { roles: ["ADMIN", "ADVISOR"] });
    revalidatePath(`/reconciliation/${runId}`);
    revalidatePath("/");
    return `Call recorded and the CAS trade confirmed as its execution${out.planItemId ? " (linked to the plan line)" : " (off-plan: no matching plan line)"}.`;
  });
}

/** Re-check the run's CAS: match transactions it has no row for yet (e.g. after a reader fix, or a call recorded since). */
export async function recheckRunAction(runId: string, _p: ActionResult | null, _fd: FormData): Promise<ActionResult> {
  return runAction("recheckRun", async () => {
    const out = await actionTx((tx, actor) => recheckRun(tx, actor, runId));
    revalidatePath(`/reconciliation/${runId}`);
    revalidatePath("/");
    const history = out.closedHistory ? ` ${out.closedHistory} row(s) dated before the previous CAS were closed as history.` : "";
    if (!out.added) return `Nothing new to match.${history}`;
    return `${out.added} transaction row(s) added${out.needsReview ? `, ${out.needsReview} need your decision` : ", all matched automatically"}.${history}`;
  });
}

export interface BulkUnadvisedInput {
  ids: string[];
  /** ADVISED: a call was given outside the dashboard; NOT_ADVISED: the client acted on their own. */
  decision: "ADVISED" | "NOT_ADVISED";
  note?: string | null;
  channel?: Channel;
  /** IST datetime-local for every call; empty = each trade's own day at 09:00. */
  communicatedAt?: string | null;
}
export interface BulkUnadvisedResult { ok: number; failed: { id: string; error: string }[] }

/** Review many unadvised trades at once. Each trade is saved on its own, so one failure does not undo the rest. */
export async function bulkUnadvisedAction(runId: string, input: BulkUnadvisedInput): Promise<BulkUnadvisedResult> {
  const ids = [...new Set((input.ids ?? []).filter((x) => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x)))].slice(0, 500);
  const out: BulkUnadvisedResult = { ok: 0, failed: [] };
  if (!ids.length) return { ok: 0, failed: [{ id: "", error: "Select at least one trade." }] };
  const note = input.note?.trim() || null;
  if (input.decision === "NOT_ADVISED" && !note) return { ok: 0, failed: [{ id: "", error: "Add a note (e.g. what the client said)." }] };
  const channel = (CHANNELS as readonly string[]).includes(input.channel ?? "") ? (input.channel as Channel) : "PHONE";
  let at: Date | null = null;
  if (input.communicatedAt) {
    at = fromISTDateTimeLocal(input.communicatedAt);
    if (Number.isNaN(at.getTime())) return { ok: 0, failed: [{ id: "", error: "Invalid call time." }] };
  }
  // Only rows of this run (the page never sends others; this keeps it that way).
  const inRun = new Set((await actionTx((tx) => tx<{ id: string }[]>`
    select id from public.reconciliation_matches where run_id = ${runId} and id = any(${ids}::uuid[])`)).map((r) => r.id));
  for (const id of ids) {
    if (!inRun.has(id)) {
      out.failed.push({ id, error: "This trade is not part of this CAS matching run." });
      continue;
    }
    try {
      if (input.decision === "ADVISED") {
        await actionTx((tx, actor) => recordAdvisedOffline(tx, actor, id, { channel, communicatedAt: at, note }), { roles: ["ADMIN", "ADVISOR"] });
      } else {
        await actionTx((tx, actor) => resolveMatch(tx, actor, id, "ACKNOWLEDGE", { note }));
      }
      out.ok++;
    } catch (e) {
      if (!(e instanceof AppError)) logServerError("reconciliation:bulk", e);
      out.failed.push({ id, error: toUserMessage(e) });
    }
  }
  revalidatePath(`/reconciliation/${runId}`);
  revalidatePath("/");
  return out;
}
