import { setAuditReason, type Actor, type Tx } from "@/lib/db/tx";
import { sameInvestor } from "@/lib/parsers/advisory-report";
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

/**
 * The client a CAS belongs to: by PAN; else a client onboarded without a PAN (a new investor
 * onboarded from the report alone) whose mobile number, or else whose name, matches the CAS,
 * when exactly one does. With `claim`, that client takes the CAS's PAN from now on.
 */
export async function findClientForCas(
  tx: Tx,
  investor: { pan: string | null; mobile?: string | null; name?: string | null },
  opts: { claim?: boolean } = {},
): Promise<IntakeClient | null> {
  const byPan = await findClientByPan(tx, investor.pan);
  if (byPan || !investor.pan) return byPan;
  const open = await tx<IntakeClient[]>`
    select id, client_code, full_name, phone, email, pan from public.clients where pan is null and deleted_at is null`;
  const mobile = (investor.mobile ?? "").replace(/\D/g, "").slice(-10);
  const byPhone = mobile.length === 10 ? open.filter((c) => (c.phone ?? "").replace(/\D/g, "").slice(-10) === mobile) : [];
  const byName = investor.name ? open.filter((c) => sameInvestor(c.full_name, investor.name ?? null)) : [];
  const hit = byPhone.length === 1 ? byPhone[0] : byPhone.length === 0 && byName.length === 1 ? byName[0] : null;
  if (hit && opts.claim) await claimPan(tx, hit.id, investor.pan);
  return hit && opts.claim ? { ...hit, pan: investor.pan.toUpperCase() } : hit;
}

/** Record a PAN read from the client's CAS on a client onboarded without one. */
export async function claimPan(tx: Tx, clientId: string, pan: string): Promise<void> {
  await setAuditReason(tx, "PAN read from the client's CAS (onboarded without a PAN)");
  await tx`select public.claim_client_pan(${clientId}, ${pan})`;
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
  args: {
    clientId: string; file: StoredFile; parsed: CasParseOutput; passwordProtected: boolean; autoConfirm?: boolean;
    /** A CAS already stored and registered (uploaded earlier, not yet read): read into it instead of registering again. */
    existingCasDocumentId?: string;
  },
): Promise<CasIntakeOutcome> {
  const reg = args.existingCasDocumentId
    ? { casDocumentId: args.existingCasDocumentId }
    : await registerCasDocument(tx, actor?.id ?? null, {
    clientId: args.clientId,
    fileName: args.file.fileName,
    mimeType: args.file.mimeType,
    sizeBytes: args.file.size,
    sha256: args.file.sha256,
    filePath: args.file.path,
    source: args.parsed.source,
    passwordProtected: args.passwordProtected,
    notes: args.parsed.readByAi ? "Read by Claude (picture-only PDF): check before it counts" : "Read by the built-in CAS parser",
  });
  if (args.existingCasDocumentId) {
    await tx`update public.cas_documents set notes = ${args.parsed.readByAi ? "Read by Claude (picture-only PDF): check before it counts" : "Read by the built-in CAS parser"}, parse_error = null where id = ${args.existingCasDocumentId}`;
  }

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

  // Claude's transcription never counts until a person has checked it.
  if (ingest.status !== "PARSED" || args.autoConfirm === false || args.parsed.readByAi) {
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
