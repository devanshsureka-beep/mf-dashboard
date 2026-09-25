import type { Actor, Tx } from "@/lib/db/tx";
import { AppError } from "@/lib/errors";
import { casParseResultSchema } from "@/lib/integrations/contracts";
import { toCasParseResult, type CasParseOutput } from "@/lib/parsers/cas";
import { confirmSnapshot, findDuplicateDocument, ingestCasParseResult, registerCasDocument } from "@/services/portfolio";
import { runReconciliation } from "@/services/reconciliation";

/**
 * CAS intake after the PDF has been read and stored: register the document,
 * create the snapshot, auto-confirm it when the parser's checks are clean
 * (holdings reconcile to the statement totals), and reconcile the new CAS
 * transactions against the calls.
 */

export interface IntakeClient {
  id: string;
  client_code: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  pan: string | null;
}

export async function findClientByPan(tx: Tx, pan: string | null): Promise<IntakeClient | null> {
  if (!pan) return null;
  const rows = await tx<IntakeClient[]>`
    select id, client_code, full_name, phone, email, pan from public.clients
    where pan = ${pan.toUpperCase()} and deleted_at is null
    order by created_at limit 1`;
  return rows[0] ?? null;
}

/** Mobile numbers of the clients this user can see (to build CAS password candidates). */
export async function knownClientPhones(tx: Tx): Promise<string[]> {
  const rows = await tx<{ phone: string }[]>`
    select phone from public.clients where phone is not null and deleted_at is null order by updated_at desc`;
  return rows.map((r) => r.phone);
}

export async function isDuplicateCas(tx: Tx, clientId: string, sha256: string): Promise<boolean> {
  return (await findDuplicateDocument(tx, clientId, "CAS", sha256)) !== null;
}

export interface StoredFile {
  fileName: string;
  mimeType: string;
  size: number;
  sha256: string;
  path: string;
}

export interface CasIntakeOutcome {
  clientId: string;
  casDocumentId: string;
  snapshotId: string | null;
  snapshotStatus: "CONFIRMED" | "PENDING_REVIEW" | "FAILED";
  isBaseline: boolean;
  valuationDate: string | null;
  runId: string | null;
  summary: Record<string, number> | null;
  warnings: string[];
}

export async function ingestParsedCas(
  tx: Tx,
  actor: Actor | null,
  args: { clientId: string; file: StoredFile; parsed: CasParseOutput; passwordProtected: boolean; autoConfirm?: boolean },
): Promise<CasIntakeOutcome> {
  const reg = await registerCasDocument(tx, actor?.id ?? null, {
    clientId: args.clientId,
    fileName: args.file.fileName,
    mimeType: args.file.mimeType,
    sizeBytes: args.file.size,
    sha256: args.file.sha256,
    filePath: args.file.path,
    source: args.parsed.source,
    passwordProtected: args.passwordProtected,
    notes: "Read by the built-in CAS parser",
  });

  const contract = casParseResultSchema.safeParse(toCasParseResult(args.parsed, reg.casDocumentId));
  if (!contract.success) {
    const why = contract.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new AppError(`The CAS was read but failed validation (${why}).`);
  }
  const ingest = await ingestCasParseResult(tx, contract.data, actor?.id ?? null);
  const base = {
    clientId: args.clientId,
    casDocumentId: reg.casDocumentId,
    snapshotId: ingest.snapshotId,
    valuationDate: contract.data.status === "PARSED" ? contract.data.statement.valuation_date : null,
    warnings: ingest.warnings,
  };
  if (!ingest.snapshotId || ingest.status === "FAILED") {
    return { ...base, snapshotStatus: "FAILED", isBaseline: false, runId: null, summary: null };
  }

  // Fill contact details the CAS carries when the client record has none.
  await tx`
    update public.clients set
      phone = coalesce(phone, ${args.parsed.investor.mobile}),
      email = coalesce(email, ${args.parsed.investor.email?.toLowerCase() ?? null})
    where id = ${args.clientId} and (phone is null or email is null)`;

  if (ingest.status !== "PARSED" || args.autoConfirm === false) {
    return { ...base, snapshotStatus: "PENDING_REVIEW", isBaseline: false, runId: null, summary: null };
  }

  const confirmed = await confirmSnapshot(
    tx,
    ingest.snapshotId,
    "Auto-confirmed: read by the built-in parser; units, values and statement totals reconcile.",
  );
  let runId: string | null = null;
  let summary: CasIntakeOutcome["summary"] = null;
  if (confirmed.previousSnapshotId) {
    const run = await runReconciliation(tx, actor, { clientId: args.clientId, currentSnapshotId: ingest.snapshotId });
    runId = run.runId;
    const s = await tx<{ summary: Record<string, number> }[]>`select summary from public.reconciliation_runs where id = ${run.runId}`;
    summary = s[0]?.summary ?? null;
  }
  return { ...base, snapshotStatus: "CONFIRMED", isBaseline: confirmed.isBaseline, runId, summary };
}
