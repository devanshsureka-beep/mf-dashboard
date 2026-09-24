"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { optStr, reqStr, runAction, str, type ActionResult } from "@/lib/actions";
import { AppError } from "@/lib/errors";
import { advisoryReportResultSchema } from "@/lib/integrations/contracts";
import { n8nConfigured, notify, triggerAdvisoryParse } from "@/lib/integrations/n8n";
import { actionTx, ADVISORY_ROLES } from "@/lib/server";
import { objectPath, prepareUpload, signedUrlForService, uploadAsUser } from "@/lib/storage";
import { getClientSummary } from "@/services/clients";
import { registerDocument } from "@/services/documents";
import { ingestAdvisoryReport } from "@/services/plans";

const TYPES = ["ADVISORY_REPORT", "EXECUTION_PROOF", "KYC", "OTHER"];

export async function uploadDocumentAction(clientId: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction("uploadDocument", async () => {
    const type = reqStr(fd, "document_type", "Type");
    if (!TYPES.includes(type)) throw new AppError("Invalid document type (upload CAS files from the CAS page).");
    const file = await prepareUpload(fd.get("file") as File | null);
    const client = await actionTx((tx) => getClientSummary(tx, clientId));
    const path = objectPath(clientId, type, file);
    const extract = type === "ADVISORY_REPORT" && str(fd, "extract") === "yes" && n8nConfigured.advisoryParse();
    await uploadAsUser(path, file);
    const docId = await actionTx((tx, actor) => registerDocument(tx, actor.id, {
      clientId, type, filePath: path, fileName: file.fileName, mimeType: file.mimeType, sizeBytes: file.size,
      sha256: file.sha256, description: optStr(fd, "description"), parseStatus: type === "ADVISORY_REPORT" ? (extract ? "PROCESSING" : "UPLOADED") : "NOT_APPLICABLE",
    }));
    revalidatePath(`/clients/${clientId}`);
    if (extract) {
      const sent = await triggerAdvisoryParse({
        documentId: docId, clientCode: client.client_code, clientName: client.full_name, fileUrl: await signedUrlForService(path, 600),
      });
      if (!sent.ok) {
        await actionTx((tx) => tx`update public.documents set parse_status = 'FAILED', parse_error = ${`Webhook HTTP ${sent.status}`} where id = ${docId}`);
        return "Uploaded, but the extraction webhook failed. Import the extraction JSON manually below.";
      }
      return "Uploaded and sent for extraction. A DRAFT plan will appear for review — it is never activated automatically.";
    }
    return "Document uploaded.";
  });
}

/** Manual advisory-report import: creates a DRAFT plan (RULE 5: never ACTIVE). */
export async function importAdvisoryJsonAction(clientId: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  let planId: string | null = null;
  const res = await runAction("importAdvisoryJson", async () => {
    let raw: unknown;
    try {
      raw = JSON.parse(reqStr(fd, "payload", "Extraction JSON"));
    } catch {
      throw new AppError("The text is not valid JSON.");
    }
    if (raw && typeof raw === "object") {
      const r = raw as Record<string, unknown>;
      r.client_id = clientId;
      delete r.client_code;
    }
    const parsed = advisoryReportResultSchema.safeParse(raw);
    if (!parsed.success) throw new AppError(`Validation failed: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    const out = await actionTx((tx, actor) => ingestAdvisoryReport(tx, parsed.data, actor.id), { roles: ADVISORY_ROLES });
    planId = out.planId;
    notify({ event: "plan.draft_created", client: { id: clientId, client_code: "", full_name: "" }, data: { plan_id: planId, items_needing_review: out.itemsNeedingReview } });
  });
  if (!res.ok) return res;
  redirect(planId ? `/clients/${clientId}/plans/${planId}` : `/clients/${clientId}?tab=plan`);
}
