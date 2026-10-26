"use server";

import { revalidatePath } from "next/cache";
import { runAction, type ActionResult } from "@/lib/actions";
import { inputsFromEntries } from "@/lib/domain/quarterly-inputs";
import { actionTx, ADVISORY_ROLES } from "@/lib/server";
import { saveFundBenchmark, saveMarketContext, saveReviewInputs } from "@/services/quarterly-review";

const entries = (fd: FormData) => [...fd.entries()].filter((e): e is [string, string] => typeof e[1] === "string");

/** Everything the advisor writes for this client's review; "index.<isin>" fields set each fund's index (for every client). */
export async function saveQuarterlyAction(clientId: string, quarterEnd: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction("saveQuarterly", async () => {
    await actionTx(async (tx, actor) => {
      await saveReviewInputs(tx, actor, clientId, quarterEnd, inputsFromEntries(entries(fd)));
      for (const [name, value] of entries(fd)) {
        if (!name.startsWith("index.")) continue;
        const was = String(fd.get(`$was.${name}`) ?? "");
        if (value !== was) await saveFundBenchmark(tx, actor, name.slice("index.".length), value);
      }
    }, { roles: ADVISORY_ROLES });
    revalidatePath(`/clients/${clientId}/quarterly`);
    return "Saved. Preview the PDF to check it.";
  });
}

/** The quarter's index valuations: shared by every client's review for that quarter. */
export async function saveMarketAction(clientId: string, quarterEnd: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction("saveMarket", async () => {
    const rows = [0, 1, 2, 3, 4, 5].map((i) => ({
      index: String(fd.get(`m.${i}.index`) ?? "").trim(), peNow: String(fd.get(`m.${i}.pe`) ?? "").trim(), median: String(fd.get(`m.${i}.median`) ?? "").trim(),
    })).filter((r) => r.index || r.peNow || r.median);
    const asOf = String(fd.get("m.asOf") ?? "").trim();
    const note = String(fd.get("m.note") ?? "").trim();
    await actionTx((tx, actor) => saveMarketContext(tx, actor, quarterEnd, { rows, ...(asOf ? { asOf } : {}), ...(note ? { note } : {}) }), { roles: ADVISORY_ROLES });
    revalidatePath(`/clients/${clientId}/quarterly`);
    return "Market table saved for every client's review this quarter.";
  });
}
