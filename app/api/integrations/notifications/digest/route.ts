import { NextResponse, type NextRequest } from "next/server";
import { withSystemTx } from "@/lib/db/tx";
import { integrationError, verifyIntegrationRequest } from "@/lib/integrations/auth";
import { getCommandCentreMetrics } from "@/services/dashboard";

/**
 * POST /api/integrations/notifications/digest
 * For scheduled n8n notifications (e.g. 6 PM WhatsApp/email digest):
 * returns today's metrics plus pending calls grouped by advisor. Read-only.
 */
export async function POST(req: NextRequest) {
  const denied = verifyIntegrationRequest(req);
  if (denied) return denied;
  try {
    const out = await withSystemTx("integration:n8n", async (tx) => ({
      metrics: await getCommandCentreMetrics(tx),
      pending_by_advisor: await tx`
        select p.advisor_id, p.advisor_name, count(*)::int as open_calls, sum(p.pending_amount) as pending_amount,
               count(*) filter (where p.age_days > 3)::int as stale_calls
        from public.v_pending_executions p group by p.advisor_id, p.advisor_name order by pending_amount desc`,
      stale_calls: await tx`
        select client_code, client_name, advisor_name, action, scheme_name, pending_amount, age_days
        from public.v_pending_executions where age_days > 3 order by age_days desc limit 50`,
    }));
    return NextResponse.json({ ok: true, generated_at: new Date().toISOString(), ...out });
  } catch (e) {
    return integrationError("digest", e);
  }
}
