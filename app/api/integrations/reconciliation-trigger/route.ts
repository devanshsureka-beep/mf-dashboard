import { NextResponse, type NextRequest } from "next/server";
import { withSystemTx } from "@/lib/db/tx";
import { AppError } from "@/lib/errors";
import { integrationError, readJson, verifyIntegrationRequest } from "@/lib/integrations/auth";
import { reconciliationTriggerSchema } from "@/lib/integrations/contracts";
import { runReconciliation } from "@/services/reconciliation";

/**
 * POST /api/integrations/reconciliation-trigger
 * Compare the client's latest (or given) CONFIRMED snapshot with the previous
 * one. Only proposes matches; people confirm them in the UI.
 */
export async function POST(req: NextRequest) {
  const denied = verifyIntegrationRequest(req);
  if (denied) return denied;
  const body = await readJson(req, reconciliationTriggerSchema);
  if ("response" in body) return body.response;
  try {
    const out = await withSystemTx("integration:n8n", async (tx) => {
      const c = await tx<{ id: string }[]>`
        select id from public.clients
        where (${body.data.client_id ?? null}::uuid is not null and id = ${body.data.client_id ?? null})
           or (${body.data.client_code ?? null}::text is not null and client_code = ${body.data.client_code ?? null})`;
      if (!c[0]) throw new AppError("Client not found.", "NOT_FOUND");
      const snap = body.data.current_snapshot_id
        ? body.data.current_snapshot_id
        : (await tx<{ snapshot_id: string }[]>`select snapshot_id from public.v_latest_snapshot where client_id = ${c[0].id}`)[0]?.snapshot_id;
      if (!snap) throw new AppError("Client has no confirmed snapshot.");
      return runReconciliation(tx, null, { clientId: c[0].id, currentSnapshotId: snap });
    });
    return NextResponse.json({ ok: true, run_id: out.runId, existing: out.existing }, { status: out.existing ? 200 : 201 });
  } catch (e) {
    return integrationError("reconciliation-trigger", e);
  }
}
