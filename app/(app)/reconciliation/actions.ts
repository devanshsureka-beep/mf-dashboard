"use server";

import { revalidatePath } from "next/cache";
import { num, optStr, reqStr, runAction, type ActionResult } from "@/lib/actions";
import { AppError } from "@/lib/errors";
import { actionTx } from "@/lib/server";
import { cancelRun, resolveMatch, type MatchDecision } from "@/services/reconciliation";

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
