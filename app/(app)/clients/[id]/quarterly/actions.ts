"use server";

import { revalidatePath } from "next/cache";
import { runAction, type ActionResult } from "@/lib/actions";
import { actionTx, ADVISORY_ROLES } from "@/lib/server";
import { saveFundBenchmark, saveMarketContext, saveReviewInputs } from "@/services/quarterly-review";
import type { SavePayload } from "./review-pages";

/**
 * Everything the advisor wrote on the review pages, in one transaction: this client's texts, the
 * quarter's valuation table (shared by every client's review) and any fund's index (for every client).
 */
export async function saveQuarterlyPageAction(clientId: string, quarterEnd: string, payload: SavePayload): Promise<ActionResult> {
  return runAction("saveQuarterly", async () => {
    await actionTx(async (tx, actor) => {
      await saveReviewInputs(tx, actor, clientId, quarterEnd, payload.inputs ?? {});
      if (payload.market) await saveMarketContext(tx, actor, quarterEnd, payload.market);
      for (const [isin, code] of Object.entries(payload.index ?? {})) await saveFundBenchmark(tx, actor, isin, String(code));
    }, { roles: ADVISORY_ROLES });
    revalidatePath(`/clients/${clientId}/quarterly`);
    return "Saved. The PDF uses the same text.";
  });
}
