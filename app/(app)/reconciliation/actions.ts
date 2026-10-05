"use server";

import { revalidatePath } from "next/cache";
import { num, optStr, reqStr, runAction, type ActionResult } from "@/lib/actions";
import { AppError } from "@/lib/errors";
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
    if (!out.added) return "Nothing new: every transaction in this CAS is already matched.";
    return `${out.added} transaction row(s) added${out.needsReview ? `, ${out.needsReview} need your decision` : ", all matched automatically"}.`;
  });
}
