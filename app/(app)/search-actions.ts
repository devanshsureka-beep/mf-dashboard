"use server";

import { actionTx } from "@/lib/server";
import { searchClients, type ClientHit } from "@/services/clients";

/** Live client search for the sidebar box (results while typing). */
export async function searchClientsAction(q: string): Promise<ClientHit[]> {
  if (typeof q !== "string" || !q.trim()) return [];
  try {
    return await actionTx((tx) => searchClients(tx, q));
  } catch {
    return [];
  }
}
