import { NextResponse, type NextRequest } from "next/server";
import { withSystemTx } from "@/lib/db/tx";
import { integrationError, readJson, verifyIntegrationRequest } from "@/lib/integrations/auth";
import { advisoryReportResultSchema } from "@/lib/integrations/contracts";
import { notify } from "@/lib/integrations/n8n";
import { ingestAdvisoryReport } from "@/services/plans";

/**
 * POST /api/integrations/advisory-report-result
 * Creates a DRAFT advisory plan from an extracted report. Never activates it.
 */
export async function POST(req: NextRequest) {
  const denied = verifyIntegrationRequest(req);
  if (denied) return denied;
  const body = await readJson(req, advisoryReportResultSchema);
  if ("response" in body) return body.response;
  try {
    const out = await withSystemTx("integration:n8n", (tx) => ingestAdvisoryReport(tx, body.data, null), {
      reason: "Advisory report extraction received from n8n",
    });
    if (out.planId) {
      notify({ event: "plan.draft_created", client: { id: out.clientId, client_code: body.data.client_code ?? "", full_name: "" }, data: { plan_id: out.planId, items_needing_review: out.itemsNeedingReview } });
    }
    return NextResponse.json({ ok: true, plan_status: out.planId ? "DRAFT" : null, ...out }, { status: out.planId ? 201 : 200 });
  } catch (e) {
    return integrationError("advisory-report-result", e);
  }
}
