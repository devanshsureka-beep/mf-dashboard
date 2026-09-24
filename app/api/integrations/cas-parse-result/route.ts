import { NextResponse, type NextRequest } from "next/server";
import { withSystemTx } from "@/lib/db/tx";
import { integrationError, readJson, verifyIntegrationRequest } from "@/lib/integrations/auth";
import { casParseResultSchema } from "@/lib/integrations/contracts";
import { notify } from "@/lib/integrations/n8n";
import { ingestCasParseResult } from "@/services/portfolio";

/**
 * POST /api/integrations/cas-parse-result
 * n8n callback with the extracted CAS. Validated before any write; idempotent
 * per cas_document_id. Creates a PENDING_REVIEW snapshot (a person confirms it).
 */
export async function POST(req: NextRequest) {
  const denied = verifyIntegrationRequest(req);
  if (denied) return denied;
  const body = await readJson(req, casParseResultSchema);
  if ("response" in body) return body.response;
  try {
    const out = await withSystemTx("integration:n8n", (tx) => ingestCasParseResult(tx, body.data, null), {
      reason: "CAS extraction result received from n8n",
    });
    const client = await withSystemTx("integration:n8n", (tx) => tx<{ id: string; client_code: string; full_name: string }[]>`
      select c.id, c.client_code, c.full_name from public.cas_documents cd join public.clients c on c.id = cd.client_id
      where cd.id = ${body.data.cas_document_id}`);
    if (!out.duplicate && client[0]) {
      notify({
        event: out.status === "FAILED" ? "cas.failed" : "cas.parsed", client: client[0],
        data: { cas_document_id: body.data.cas_document_id, snapshot_id: out.snapshotId, status: out.status, warnings: out.warnings.length },
      });
    }
    return NextResponse.json({ ok: true, ...out }, { status: out.duplicate ? 200 : 201 });
  } catch (e) {
    return integrationError("cas-parse-result", e);
  }
}
