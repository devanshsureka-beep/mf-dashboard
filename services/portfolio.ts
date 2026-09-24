import { createHash } from "node:crypto";
import type { Tx } from "@/lib/db/tx";
import { AppError } from "@/lib/errors";
import type { CasParsed, CasParseResult, CasTransactionInput } from "@/lib/integrations/contracts";
import type { CasDocumentRow, HoldingRow, SnapshotRow } from "@/types/domain";
import { resolveOrCreateSecurity } from "./securities";

// -----------------------------------------------------------------------------
// Queries
// -----------------------------------------------------------------------------
export async function listSnapshots(tx: Tx, clientId: string): Promise<SnapshotRow[]> {
  return tx<SnapshotRow[]>`
    select * from public.portfolio_snapshots where client_id = ${clientId}
    order by snapshot_date desc, created_at desc`;
}

export async function getSnapshot(tx: Tx, snapshotId: string): Promise<SnapshotRow> {
  const rows = await tx<SnapshotRow[]>`select * from public.portfolio_snapshots where id = ${snapshotId}`;
  if (!rows[0]) throw new AppError("Snapshot not found.", "NOT_FOUND");
  return rows[0];
}

export async function getHoldings(tx: Tx, snapshotId: string): Promise<HoldingRow[]> {
  return tx<HoldingRow[]>`
    select id, snapshot_id, security_id, scheme_name, amc, folio_number, isin, plan_type, category,
           units, cost_value, current_value, latest_nav, latest_nav_date
    from public.portfolio_holdings where snapshot_id = ${snapshotId}
    order by current_value desc`;
}

export async function listCasDocuments(tx: Tx, clientId?: string): Promise<(CasDocumentRow & { client_name: string; client_code: string })[]> {
  return tx<(CasDocumentRow & { client_name: string; client_code: string })[]>`
    select cd.*, d.file_name, s.id as snapshot_id, s.review_status as snapshot_review_status,
           c.full_name as client_name, c.client_code
    from public.cas_documents cd
    join public.documents d on d.id = cd.document_id
    join public.clients c on c.id = cd.client_id
    left join public.portfolio_snapshots s on s.cas_document_id = cd.id
    where (${clientId ?? null}::uuid is null or cd.client_id = ${clientId ?? null})
    order by cd.uploaded_at desc
    limit 200`;
}

export async function listRecentTransactions(tx: Tx, clientId: string, limit = 200) {
  return tx<{
    id: string; transaction_date: string; transaction_type: string; scheme_name: string; folio_number: string | null;
    units: number | null; nav: number | null; amount: number | null; balance_units: number | null;
  }[]>`
    select id, transaction_date, transaction_type, scheme_name, folio_number, units, nav, amount, balance_units
    from public.portfolio_transactions where client_id = ${clientId}
    order by transaction_date desc, created_at desc limit ${limit}`;
}

// -----------------------------------------------------------------------------
// CAS registration (file already stored in the private bucket)
// -----------------------------------------------------------------------------
export interface RegisterCasInput {
  clientId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  filePath: string;
  source: string;
  passwordProtected: boolean;
  notes?: string | null;
}

export async function findDuplicateDocument(tx: Tx, clientId: string, type: string, sha256: string) {
  const rows = await tx<{ id: string; created_at: Date }[]>`
    select id, created_at from public.documents
    where client_id = ${clientId} and document_type = ${type} and sha256 = ${sha256} and deleted_at is null`;
  return rows[0] ?? null;
}

export async function registerCasDocument(
  tx: Tx,
  actorId: string | null,
  input: RegisterCasInput,
): Promise<{ casDocumentId: string; documentId: string }> {
  const dup = await findDuplicateDocument(tx, input.clientId, "CAS", input.sha256);
  if (dup) throw new AppError("This CAS file has already been uploaded for this client (duplicate detected by file hash).", "CONFLICT");

  const doc = await tx<{ id: string }[]>`
    insert into public.documents (client_id, document_type, file_path, file_name, mime_type, size_bytes, sha256, parse_status, created_by)
    values (${input.clientId}, 'CAS', ${input.filePath}, ${input.fileName}, ${input.mimeType}, ${input.sizeBytes},
            ${input.sha256}, 'UPLOADED', ${actorId})
    returning id`;
  const cas = await tx<{ id: string }[]>`
    insert into public.cas_documents (client_id, document_id, file_path, file_sha256, source, password_protected, notes, created_by)
    values (${input.clientId}, ${doc[0].id}, ${input.filePath}, ${input.sha256}, ${input.source},
            ${input.passwordProtected}, ${input.notes ?? null}, ${actorId})
    returning id`;
  return { casDocumentId: cas[0].id, documentId: doc[0].id };
}

export async function setCasStatus(
  tx: Tx,
  casDocumentId: string,
  status: "PROCESSING" | "FAILED" | "UPLOADED",
  error?: string | null,
): Promise<void> {
  const rows = await tx<{ document_id: string }[]>`
    update public.cas_documents
       set parse_status = ${status},
           parse_error = ${error ?? null},
           processing_started_at = case when ${status} = 'PROCESSING' then now() else processing_started_at end
     where id = ${casDocumentId}
     returning document_id`;
  if (!rows[0]) throw new AppError("CAS document not found.", "NOT_FOUND");
  await tx`update public.documents set parse_status = ${status}, parse_error = ${error ?? null} where id = ${rows[0].document_id}`;
}

// -----------------------------------------------------------------------------
// Parse-result ingestion (n8n callback and manual JSON import share this path)
// -----------------------------------------------------------------------------
export function transactionDedupeHash(t: CasTransactionInput): string {
  const key = [
    t.folio_number ?? "", t.isin ?? t.scheme_name.toLowerCase(), t.date, t.type,
    t.units ?? "", t.amount ?? "", t.balance_units ?? "",
  ].join("|");
  return createHash("sha256").update(key).digest("hex");
}

/** Deterministic validation of an extraction. Warnings send the CAS to NEEDS_REVIEW. */
export function validateCasExtraction(parsed: CasParsed, clientPan: string | null): string[] {
  const warnings = [...parsed.warnings];
  const sumCurrent = parsed.holdings.reduce((s, h) => s + h.current_value, 0);
  const declared = parsed.totals?.current_value;
  if (declared && Math.abs(sumCurrent - declared) > Math.max(1, declared * 0.005)) {
    warnings.push(
      `Holdings add up to ₹${Math.round(sumCurrent).toLocaleString("en-IN")} but the statement total is ₹${Math.round(declared).toLocaleString("en-IN")}.`,
    );
  }
  for (const h of parsed.holdings) {
    if (h.nav && h.units > 0) {
      const implied = h.units * h.nav;
      if (Math.abs(implied - h.current_value) > Math.max(10, h.current_value * 0.02)) {
        warnings.push(`${h.scheme_name}: units × NAV (₹${Math.round(implied).toLocaleString("en-IN")}) does not match value (₹${Math.round(h.current_value).toLocaleString("en-IN")}).`);
      }
    }
    if (!h.isin) warnings.push(`${h.scheme_name}: ISIN missing — security matched by name only.`);
  }
  const pan = parsed.statement.investor_pan;
  if (pan && clientPan && pan !== clientPan) {
    warnings.push(`Statement PAN ${pan} does not match the client's PAN ${clientPan}.`);
  }
  return warnings;
}

export interface CreateSnapshotArgs {
  clientId: string;
  casDocumentId: string | null;
  parsed: CasParsed;
  source: "CAS" | "MANUAL" | "IMPORT" | "SEED";
  reviewStatus?: "PENDING_REVIEW" | "CONFIRMED";
  createdBy: string | null;
}

/** Creates a NEW snapshot with holdings and (deduplicated) transactions. Never overwrites. */
export async function createSnapshotFromParsed(tx: Tx, a: CreateSnapshotArgs): Promise<string> {
  const p = a.parsed;
  const totalCurrent = p.holdings.reduce((s, h) => s + h.current_value, 0);
  const totalInvested = p.holdings.reduce((s, h) => s + (h.cost_value ?? 0), 0);

  const snap = await tx<{ id: string }[]>`
    insert into public.portfolio_snapshots
      (client_id, cas_document_id, snapshot_date, total_invested_value, total_current_value, source,
       extraction_method, holdings_count, created_by)
    values (${a.clientId}, ${a.casDocumentId}, ${p.statement.valuation_date}, ${round2(totalInvested)},
            ${round2(totalCurrent)}, ${a.source},
            ${a.source === "SEED" ? "SEED" : p.extraction_method}, ${p.holdings.length}, ${a.createdBy})
    returning id`;
  const snapshotId = snap[0].id;

  // Merge duplicate lines (same folio + ISIN/name) defensively.
  const merged = new Map<string, (typeof p.holdings)[number]>();
  for (const h of p.holdings) {
    const k = `${h.folio_number ?? ""}|${h.isin ?? h.scheme_name}`;
    const prev = merged.get(k);
    merged.set(
      k,
      prev
        ? { ...prev, units: prev.units + h.units, current_value: prev.current_value + h.current_value, cost_value: (prev.cost_value ?? 0) + (h.cost_value ?? 0) }
        : h,
    );
  }

  const securityCache = new Map<string, string>();
  const secFor = async (x: { isin?: string | null; scheme_name: string; amc?: string | null; category?: string | null; plan_type?: string | null }) => {
    const k = x.isin ?? `name:${x.scheme_name.toLowerCase()}`;
    const hit = securityCache.get(k);
    if (hit) return hit;
    const id = await resolveOrCreateSecurity(tx, x, a.createdBy);
    securityCache.set(k, id);
    return id;
  };

  for (const h of merged.values()) {
    const securityId = await secFor(h);
    await tx`
      insert into public.portfolio_holdings
        (snapshot_id, client_id, security_id, scheme_name, amc, folio_number, isin, plan_type, category,
         units, cost_value, current_value, latest_nav, latest_nav_date)
      values (${snapshotId}, ${a.clientId}, ${securityId}, ${h.scheme_name}, ${h.amc ?? null}, ${h.folio_number ?? null},
              ${h.isin ?? null}, ${h.plan_type ?? null}, ${h.category ?? null}, ${h.units}, ${h.cost_value ?? null},
              ${h.current_value}, ${h.nav ?? null}, ${h.nav_date ?? p.statement.valuation_date})`;
  }

  for (const t of p.transactions) {
    const securityId = await secFor({ isin: t.isin, scheme_name: t.scheme_name });
    await tx`
      insert into public.portfolio_transactions
        (client_id, source_snapshot_id, security_id, transaction_date, transaction_type, scheme_name, isin,
         folio_number, units, nav, amount, balance_units, description, dedupe_hash)
      values (${a.clientId}, ${snapshotId}, ${securityId}, ${t.date}, ${t.type}, ${t.scheme_name}, ${t.isin ?? null},
              ${t.folio_number ?? null}, ${t.units ?? null}, ${t.nav ?? null}, ${t.amount ?? null},
              ${t.balance_units ?? null}, ${t.description ?? null}, ${transactionDedupeHash(t)})
      on conflict (client_id, dedupe_hash) do nothing`;
  }

  if (a.reviewStatus === "CONFIRMED") {
    await tx`update public.portfolio_snapshots set review_status = 'CONFIRMED', review_note = 'Auto-confirmed (seed)' where id = ${snapshotId}`;
  }
  return snapshotId;
}

/**
 * Apply an extraction result to a CAS document. Idempotent: a second callback
 * for the same CAS returns the existing snapshot instead of creating another.
 */
export async function ingestCasParseResult(
  tx: Tx,
  result: CasParseResult,
  actorId: string | null,
): Promise<{ status: "FAILED" | "PARSED" | "NEEDS_REVIEW"; snapshotId: string | null; duplicate: boolean; warnings: string[] }> {
  const cas = await tx<{ id: string; client_id: string; document_id: string; parse_status: string; pan: string | null }[]>`
    select cd.id, cd.client_id, cd.document_id, cd.parse_status, c.pan
    from public.cas_documents cd join public.clients c on c.id = cd.client_id
    where cd.id = ${result.cas_document_id}
    for update of cd`;
  const doc = cas[0];
  if (!doc) throw new AppError("Unknown cas_document_id.", "NOT_FOUND");

  const existing = await tx<{ id: string }[]>`select id from public.portfolio_snapshots where cas_document_id = ${doc.id}`;
  if (existing[0]) {
    return { status: doc.parse_status as "PARSED", snapshotId: existing[0].id, duplicate: true, warnings: [] };
  }

  if (result.status === "FAILED") {
    await setCasStatus(tx, doc.id, "FAILED", result.error);
    return { status: "FAILED", snapshotId: null, duplicate: false, warnings: [] };
  }

  const warnings = validateCasExtraction(result, doc.pan);

  // Same holdings as an existing snapshot on the same valuation date?
  const identical = await tx<{ id: string }[]>`
    select s.id from public.portfolio_snapshots s
    where s.client_id = ${doc.client_id} and s.snapshot_date = ${result.statement.valuation_date}
      and s.review_status <> 'REJECTED'
      and abs(s.total_current_value - ${round2(result.holdings.reduce((x, h) => x + h.current_value, 0))}) < 1
    limit 1`;
  if (identical[0]) {
    warnings.push("A snapshot with the same valuation date and total value already exists — possible duplicate statement.");
  }

  const snapshotId = await createSnapshotFromParsed(tx, {
    clientId: doc.client_id,
    casDocumentId: doc.id,
    parsed: result,
    source: result.extraction_method === "MANUAL" ? "MANUAL" : "CAS",
    createdBy: actorId,
  });

  const status = warnings.length > 0 ? "NEEDS_REVIEW" : "PARSED";
  await tx`
    update public.cas_documents set
      parse_status = ${status}, parse_error = null, parse_warnings = ${tx.json(warnings)}, parsed_at = now(),
      source = ${result.statement.source}, statement_from_date = ${result.statement.statement_from_date ?? null},
      statement_to_date = ${result.statement.statement_to_date ?? null},
      valuation_date = ${result.statement.valuation_date},
      investor_name = ${result.statement.investor_name ?? null}, investor_pan = ${result.statement.investor_pan ?? null}
    where id = ${doc.id}`;
  await tx`update public.documents set parse_status = ${status}, parse_error = null where id = ${doc.document_id}`;
  return { status, snapshotId, duplicate: false, warnings };
}

// -----------------------------------------------------------------------------
// Review
// -----------------------------------------------------------------------------
/**
 * A person confirms an extracted snapshot. The first confirmed snapshot becomes
 * the baseline. Returns the previous confirmed snapshot (if any) so the caller
 * can start a reconciliation run.
 */
export async function confirmSnapshot(
  tx: Tx,
  snapshotId: string,
  note: string | null,
): Promise<{ previousSnapshotId: string | null; isBaseline: boolean }> {
  const snap = await getSnapshot(tx, snapshotId);
  if (snap.review_status !== "PENDING_REVIEW") throw new AppError(`Snapshot is already ${snap.review_status}.`);

  const hasBaseline = await tx<{ id: string }[]>`
    select id from public.portfolio_snapshots where client_id = ${snap.client_id} and is_baseline`;
  const isBaseline = hasBaseline.length === 0;

  await tx`
    update public.portfolio_snapshots
       set review_status = 'CONFIRMED', review_note = ${note}, is_baseline = ${isBaseline}
     where id = ${snapshotId}`;
  if (snap.cas_document_id) {
    const rows = await tx<{ document_id: string }[]>`
      update public.cas_documents set parse_status = 'PARSED' where id = ${snap.cas_document_id} returning document_id`;
    if (rows[0]) await tx`update public.documents set parse_status = 'PARSED' where id = ${rows[0].document_id}`;
  }

  const prev = await tx<{ id: string }[]>`
    select id from public.portfolio_snapshots
    where client_id = ${snap.client_id} and review_status = 'CONFIRMED' and id <> ${snapshotId}
      and (snapshot_date, created_at) < (${snap.snapshot_date}::date, ${snap.created_at})
    order by snapshot_date desc, created_at desc limit 1`;
  return { previousSnapshotId: prev[0]?.id ?? null, isBaseline };
}

export async function rejectSnapshot(tx: Tx, snapshotId: string, reason: string): Promise<void> {
  if (!reason.trim()) throw new AppError("A reason is required to reject a snapshot.");
  const snap = await getSnapshot(tx, snapshotId);
  if (snap.review_status !== "PENDING_REVIEW") throw new AppError(`Snapshot is already ${snap.review_status}.`);
  await tx`update public.portfolio_snapshots set review_status = 'REJECTED', review_note = ${reason} where id = ${snapshotId}`;
  if (snap.cas_document_id) {
    const rows = await tx<{ document_id: string }[]>`
      update public.cas_documents set parse_status = 'FAILED', parse_error = ${`Rejected on review: ${reason}`}
      where id = ${snap.cas_document_id} returning document_id`;
    if (rows[0]) await tx`update public.documents set parse_status = 'FAILED' where id = ${rows[0].document_id}`;
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;
