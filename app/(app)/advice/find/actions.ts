"use server";

import { actionTx } from "@/lib/server";
import { fundsMatching, type FundMatch } from "@/services/advise-desk";
import { searchClients, type ClientHit } from "@/services/clients";

/** As the advisor types: funds clients hold or plans have, and clients by name / ID / phone. */
export async function findSuggestAction(q: string): Promise<{ funds: FundMatch[]; clients: ClientHit[] }> {
  const text = String(q ?? "").trim().slice(0, 80);
  if (text.length < 2) return { funds: [], clients: [] };
  return actionTx(async (tx) => ({ funds: await fundsMatching(tx, text, 8), clients: await searchClients(tx, text, 5) }));
}
