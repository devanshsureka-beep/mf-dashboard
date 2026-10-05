"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { optStr, reqStr, runAction, str, type ActionResult } from "@/lib/actions";
import { AppError } from "@/lib/errors";
import { casParseResultSchema, CAS_SOURCES } from "@/lib/integrations/contracts";
import { n8nConfigured, notify, triggerCasParse } from "@/lib/integrations/n8n";
import { actionTx } from "@/lib/server";
import { downloadAsUser, objectPath, prepareUpload, signedUrlForService, uploadAsUser } from "@/lib/storage";
import { getClientSummary } from "@/services/clients";
import {
  confirmSnapshot, findDuplicateDocument, ingestCasParseResult, registerCasDocument, rejectSnapshot, setCasStatus,
} from "@/services/portfolio";
import { runReconciliation } from "@/services/reconciliation";
import { readClientCas } from "./read";

export async function uploadCasAction(clientId: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  let casId = "";
  const res = await runAction("uploadCas", async () => {
    const source = str(fd, "source") || "OTHER";
    if (!(CAS_SOURCES as readonly string[]).includes(source)) throw new AppError("Invalid source.");
    const file = await prepareUpload(fd.get("file") as File | null);
    if (file.mimeType !== "application/pdf") throw new AppError("A CAS must be a PDF.");
    // The password lives only in this request's memory. Never stored, never logged.
    const password = str(fd, "password") || null;
    const passwordProtected = str(fd, "password_protected") === "yes" || Boolean(password);

    const { client, unread } = await actionTx(async (tx) => {
      const dup = await findDuplicateDocument(tx, clientId, "CAS", file.sha256);
      let unread: { casId: string; path: string } | null = null;
      if (dup) {
        // Same file uploaded before: read it now if it never was, else nothing to do.
        const prior = (await tx<{ id: string; parse_status: string; file_path: string; has_snapshot: boolean }[]>`
          select cd.id, cd.parse_status, d.file_path,
                 exists (select 1 from public.portfolio_snapshots s where s.cas_document_id = cd.id) as has_snapshot
          from public.cas_documents cd join public.documents d on d.id = cd.document_id
          where cd.document_id = ${dup.id}`)[0];
        if (!prior || prior.has_snapshot || ["PARSED", "NEEDS_REVIEW", "PROCESSING"].includes(prior.parse_status)) {
          throw new AppError("This exact CAS file was already uploaded and read for this client. Open it from the client's CAS tab.", "CONFLICT");
        }
        unread = { casId: prior.id, path: prior.file_path };
      }
      return { client: await getClientSummary(tx, clientId), unread };
    });

    if (unread) {
      const out = await readClientCas({
        clientId, clientPan: client.pan, bytes: file.bytes, typedPassword: password, existingCasDocumentId: unread.casId,
        file: { fileName: file.fileName, mimeType: file.mimeType, size: file.size, sha256: file.sha256, path: unread.path },
      });
      casId = out.casDocumentId;
      return;
    }

    const path = objectPath(clientId, "CAS", file);
    await uploadAsUser(path, file);

    // Built-in reader first (as Bulk CAS Upload): snapshot + reconciliation right away.
    let readError: string | null = null;
    try {
      const out = await readClientCas({
        clientId, clientPan: client.pan, bytes: file.bytes, typedPassword: password,
        file: { fileName: file.fileName, mimeType: file.mimeType, size: file.size, sha256: file.sha256, path },
      });
      casId = out.casDocumentId;
      return;
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      readError = e.message;
    }

    // Not readable by the built-in reader: keep the file, extract via n8n or JSON from the CAS page.
    const reg = await actionTx((tx, actor) => registerCasDocument(tx, actor.id, {
      clientId, fileName: file.fileName, mimeType: file.mimeType, sizeBytes: file.size, sha256: file.sha256,
      filePath: path, source, passwordProtected, notes: optStr(fd, "notes"),
    }));
    casId = reg.casDocumentId;
    await actionTx((tx) => setCasStatus(tx, casId, "UPLOADED", `Built-in reader: ${readError}`));

    if (n8nConfigured.casParse()) {
      const url = await signedUrlForService(path, 600);
      const sent = await triggerCasParse({
        casDocumentId: casId, clientCode: client.client_code, clientName: client.full_name, fileUrl: url, source, password,
      });
      await actionTx((tx) => setCasStatus(tx, casId, sent.ok ? "PROCESSING" : "UPLOADED",
        sent.ok ? null : `Extraction webhook failed (HTTP ${sent.status}). Retry from the CAS page.`));
    }
  });
  if (!res.ok) return res;
  revalidatePath(`/clients/${clientId}`);
  redirect(`/cas/${casId}`);
}

export async function triggerExtractionAction(casId: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction("triggerExtraction", async () => {
    if (!n8nConfigured.casParse()) throw new AppError("N8N_CAS_PARSE_WEBHOOK_URL is not configured. Import the extraction JSON manually instead.", "CONFIG");
    const { doc, client } = await actionTx(async (tx) => {
      const rows = await tx<{ file_path: string; client_id: string; source: string; parse_status: string }[]>`
        select file_path, client_id, source, parse_status from public.cas_documents where id = ${casId}`;
      if (!rows[0]) throw new AppError("CAS not found.", "NOT_FOUND");
      if (["PARSED", "NEEDS_REVIEW"].includes(rows[0].parse_status)) throw new AppError("This CAS already has an extraction.");
      return { doc: rows[0], client: await getClientSummary(tx, rows[0].client_id) };
    });
    const url = await signedUrlForService(doc.file_path, 600);
    const sent = await triggerCasParse({
      casDocumentId: casId, clientCode: client.client_code, clientName: client.full_name, fileUrl: url, source: doc.source,
      password: str(fd, "password") || null,
    });
    if (!sent.ok) throw new AppError(`n8n webhook returned HTTP ${sent.status}.`);
    await actionTx((tx) => setCasStatus(tx, casId, "PROCESSING"));
    revalidatePath(`/cas/${casId}`);
    return "Sent to n8n for extraction. The status updates when the result arrives.";
  });
}

/** Manual path: paste the extraction JSON (same contract as the n8n callback). */
export async function importCasJsonAction(casId: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  let snapshotId: string | null = null;
  const res = await runAction("importCasJson", async () => {
    let raw: unknown;
    try {
      raw = JSON.parse(reqStr(fd, "payload", "Extraction JSON"));
    } catch {
      throw new AppError("The text is not valid JSON.");
    }
    if (raw && typeof raw === "object") (raw as Record<string, unknown>).cas_document_id = casId;
    const parsed = casParseResultSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError(`Validation failed: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    }
    const out = await actionTx((tx, actor) => ingestCasParseResult(tx, parsed.data, actor.id));
    snapshotId = out.snapshotId;
  });
  if (!res.ok) return res;
  revalidatePath(`/cas/${casId}`);
  redirect(snapshotId ? `/snapshots/${snapshotId}` : `/cas/${casId}`);
}

export async function markCasFailedAction(casId: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction("markCasFailed", async () => {
    await actionTx((tx) => setCasStatus(tx, casId, "FAILED", reqStr(fd, "reason", "Reason")));
    revalidatePath(`/cas/${casId}`);
    return "Marked as failed.";
  });
}

export async function confirmSnapshotAction(snapshotId: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  let target = `/snapshots/${snapshotId}`;
  const res = await runAction("confirmSnapshot", async () => {
    if (str(fd, "confirm") !== "yes") throw new AppError("Tick the box to confirm you checked the extraction against the PDF.");
    const out = await actionTx(async (tx, actor) => {
      const snap = await tx<{ client_id: string }[]>`select client_id from public.portfolio_snapshots where id = ${snapshotId}`;
      if (!snap[0]) throw new AppError("Snapshot not found.", "NOT_FOUND");
      const c = await confirmSnapshot(tx, snapshotId, optStr(fd, "note"));
      let runId: string | null = null;
      if (c.previousSnapshotId) {
        runId = (await runReconciliation(tx, actor, { clientId: snap[0].client_id, currentSnapshotId: snapshotId })).runId;
      }
      return { ...c, runId, clientId: snap[0].client_id };
    });
    if (out.runId) {
      target = `/reconciliation/${out.runId}`;
      notify({ event: "reconciliation.completed", client: { id: out.clientId, client_code: "", full_name: "" }, data: { run_id: out.runId } });
    }
  });
  if (!res.ok) return res;
  revalidatePath("/reconciliation");
  redirect(target);
}

export async function rejectSnapshotAction(snapshotId: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction("rejectSnapshot", async () => {
    await actionTx((tx) => rejectSnapshot(tx, snapshotId, reqStr(fd, "reason", "Reason")));
    revalidatePath(`/snapshots/${snapshotId}`);
    return "Snapshot rejected. It stays in history and never drives metrics. Upload a corrected CAS or re-import.";
  });
}

/** Read a CAS that was stored earlier but never read (e.g. uploaded before the built-in reader ran here). */
export async function readStoredCasAction(casId: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  let target = "";
  const res = await runAction("readStoredCas", async () => {
    const { doc, client } = await actionTx(async (tx) => {
      const rows = await tx<{ client_id: string; parse_status: string; file_path: string; file_name: string; mime_type: string; size_bytes: number; sha256: string; snapshot_id: string | null }[]>`
        select cd.client_id, cd.parse_status, d.file_path, d.file_name, d.mime_type, d.size_bytes, d.sha256,
               (select s.id from public.portfolio_snapshots s where s.cas_document_id = cd.id limit 1) as snapshot_id
        from public.cas_documents cd join public.documents d on d.id = cd.document_id
        where cd.id = ${casId}`;
      if (!rows[0]) throw new AppError("CAS not found.", "NOT_FOUND");
      return { doc: rows[0], client: await getClientSummary(tx, rows[0].client_id) };
    });
    if (doc.snapshot_id || ["PARSED", "NEEDS_REVIEW"].includes(doc.parse_status)) throw new AppError("This CAS already has an extraction.");
    const bytes = await downloadAsUser(doc.file_path);
    const out = await readClientCas({
      clientId: doc.client_id, clientPan: client.pan, bytes, typedPassword: str(fd, "password") || null,
      file: { fileName: doc.file_name, mimeType: doc.mime_type, size: Number(doc.size_bytes), sha256: doc.sha256, path: doc.file_path },
      existingCasDocumentId: casId,
    });
    target = out.snapshotId ? `/snapshots/${out.snapshotId}` : `/cas/${casId}`;
    revalidatePath(`/clients/${doc.client_id}`);
  });
  if (!res.ok) return res;
  redirect(target);
}
