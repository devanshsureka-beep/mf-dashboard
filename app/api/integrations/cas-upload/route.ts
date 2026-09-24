import { NextResponse, type NextRequest } from "next/server";
import { withSystemTx } from "@/lib/db/tx";
import { AppError } from "@/lib/errors";
import { integrationError, verifyIntegrationRequest } from "@/lib/integrations/auth";
import { casUploadTriggerSchema } from "@/lib/integrations/contracts";
import { n8nConfigured, triggerCasParse } from "@/lib/integrations/n8n";
import { objectPath, prepareUpload, signedUrlForService, uploadAsService } from "@/lib/storage";
import { findDuplicateDocument, registerCasDocument, setCasStatus } from "@/services/portfolio";

/**
 * POST /api/integrations/cas-upload  (multipart/form-data)
 * Fields: file (PDF), client_code, source, password_protected, notes, [password]
 * For n8n flows that receive CAS PDFs (e.g. from an inbox). Stores the file,
 * registers the CAS (dedup by SHA-256) and optionally triggers extraction.
 */
export async function POST(req: NextRequest) {
  const denied = verifyIntegrationRequest(req);
  if (denied) return denied;
  try {
    const fd = await req.formData();
    const meta = casUploadTriggerSchema.safeParse({
      client_code: fd.get("client_code"), source: fd.get("source") ?? undefined,
      password_protected: fd.get("password_protected") ?? undefined, notes: fd.get("notes") ?? undefined,
    });
    if (!meta.success) return NextResponse.json({ error: "Validation failed", issues: meta.error.issues }, { status: 422 });
    const file = await prepareUpload(fd.get("file") as File | null);
    if (file.mimeType !== "application/pdf") throw new AppError("A CAS must be a PDF.");

    const client = await withSystemTx("integration:n8n", async (tx) => {
      const c = await tx<{ id: string; client_code: string; full_name: string }[]>`
        select id, client_code, full_name from public.clients where client_code = ${meta.data.client_code} and deleted_at is null`;
      if (!c[0]) throw new AppError("Unknown client_code.", "NOT_FOUND");
      if (await findDuplicateDocument(tx, c[0].id, "CAS", file.sha256)) throw new AppError("Duplicate CAS (same SHA-256) already uploaded.", "CONFLICT");
      return c[0];
    });
    const path = objectPath(client.id, "CAS", file);
    await uploadAsService(path, file);
    const reg = await withSystemTx("integration:n8n", (tx) => registerCasDocument(tx, null, {
      clientId: client.id, fileName: file.fileName, mimeType: file.mimeType, sizeBytes: file.size, sha256: file.sha256,
      filePath: path, source: meta.data.source, passwordProtected: meta.data.password_protected, notes: meta.data.notes ?? null,
    }));
    let processing = false;
    if (n8nConfigured.casParse() && fd.get("trigger_parse") !== "false") {
      const sent = await triggerCasParse({
        casDocumentId: reg.casDocumentId, clientCode: client.client_code, clientName: client.full_name,
        fileUrl: await signedUrlForService(path, 600), source: meta.data.source, password: (fd.get("password") as string) || null,
      });
      processing = sent.ok;
      if (sent.ok) await withSystemTx("integration:n8n", (tx) => setCasStatus(tx, reg.casDocumentId, "PROCESSING"));
    }
    return NextResponse.json({ ok: true, cas_document_id: reg.casDocumentId, document_id: reg.documentId, processing }, { status: 201 });
  } catch (e) {
    return integrationError("cas-upload", e);
  }
}
