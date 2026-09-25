"use server";

import { revalidatePath } from "next/cache";
import { str } from "@/lib/actions";
import { casPasswordTemplate, passwordCandidates } from "@/lib/cas/password";
import { readCasPdf } from "@/lib/cas/reader";
import { AppError, logServerError, toUserMessage } from "@/lib/errors";
import { actionTx } from "@/lib/server";
import { objectPath, prepareUpload, uploadAsUser } from "@/lib/storage";
import { findClientByPan, ingestParsedCas, isDuplicateCas, knownClientPhones } from "@/services/cas-intake";

export interface BulkCasRow {
  ok: boolean;
  fileName: string;
  outcome: "RECONCILED" | "BASELINE" | "NEEDS_REVIEW" | "DUPLICATE" | "NO_CLIENT" | "ERROR";
  message: string;
  clientId?: string;
  clientName?: string;
  clientCode?: string;
  valuationDate?: string | null;
  snapshotId?: string | null;
  runId?: string | null;
  summary?: Record<string, number> | null;
}

const maskPan = (pan: string | null) => (pan ? `${pan.slice(0, 3)}XX${pan.slice(5, 9).replace(/\d/g, "X")}${pan.slice(9)}` : "unknown");

/**
 * One CAS file per call (the page loops over the dropped files). The PDF is
 * opened with the password template + each client's mobile number, matched to
 * the client by PAN, stored, snapshotted and reconciled. Passwords are never
 * stored or logged.
 */
export async function processCasFileAction(fd: FormData): Promise<BulkCasRow> {
  const f = fd.get("file");
  const fileName = f instanceof File ? f.name : "file";
  try {
    const file = await prepareUpload(f as File | null);
    if (file.mimeType !== "application/pdf") throw new AppError("A CAS must be a PDF.");

    const phones = await actionTx((tx) => knownClientPhones(tx));
    const candidates = passwordCandidates({
      template: casPasswordTemplate(),
      explicit: [str(fd, "password") || null],
      fileName: file.fileName,
      phones,
    });
    const { parsed, passwordProtected } = await readCasPdf(file.bytes, candidates);

    const client = await actionTx((tx) => findClientByPan(tx, parsed.investor.pan));
    if (!client) {
      return {
        ok: false, fileName, outcome: "NO_CLIENT",
        message: `No client with PAN ${maskPan(parsed.investor.pan)} (${parsed.investor.name ?? "unknown investor"}). Onboard the client first.`,
      };
    }
    const clientInfo = { clientId: client.id, clientName: client.full_name, clientCode: client.client_code };

    if (await actionTx((tx) => isDuplicateCas(tx, client.id, file.sha256))) {
      return { ok: true, fileName, outcome: "DUPLICATE", message: "Already uploaded earlier (same file). Nothing changed.", ...clientInfo };
    }

    const path = objectPath(client.id, "CAS", file);
    await uploadAsUser(path, file);
    const out = await actionTx((tx, actor) => ingestParsedCas(tx, actor, {
      clientId: client.id,
      file: { fileName: file.fileName, mimeType: file.mimeType, size: file.size, sha256: file.sha256, path },
      parsed,
      passwordProtected,
    }));

    const common = { ...clientInfo, valuationDate: out.valuationDate, snapshotId: out.snapshotId, runId: out.runId, summary: out.summary };
    if (out.snapshotStatus === "PENDING_REVIEW") {
      return { ok: true, fileName, outcome: "NEEDS_REVIEW", message: `Read with ${out.warnings.length} check(s) to review: ${out.warnings.slice(0, 2).join(" ")}`, ...common };
    }
    if (out.snapshotStatus === "FAILED") {
      return { ok: false, fileName, outcome: "ERROR", message: "The CAS could not be ingested.", ...common };
    }
    if (!out.runId) {
      return { ok: true, fileName, outcome: "BASELINE", message: "First CAS for this client: saved as the baseline portfolio.", ...common };
    }
    const s = out.summary ?? {};
    const parts = [
      `${s.transactions ?? 0} new transaction(s)`,
      `${s.auto_confirmed ?? 0} call execution(s) confirmed`,
      s.needs_review ? `${s.needs_review} to review` : null,
      s.unadvised ? `${s.unadvised} unadvised` : null,
      s.sip_items_completed ? `${s.sip_items_completed} SIP action(s) verified` : null,
    ].filter(Boolean);
    return { ok: true, fileName, outcome: "RECONCILED", message: parts.join(" · "), ...common };
  } catch (e) {
    if (!(e instanceof AppError)) logServerError("processCasFile", e);
    return { ok: false, fileName, outcome: "ERROR", message: toUserMessage(e) };
  } finally {
    revalidatePath("/reconciliation");
  }
}
