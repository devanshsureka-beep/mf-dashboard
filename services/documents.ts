import type { Tx } from "@/lib/db/tx";
import { AppError } from "@/lib/errors";
import type { DocumentRow } from "@/types/domain";

export async function listDocuments(tx: Tx, clientId: string): Promise<DocumentRow[]> {
  return tx<DocumentRow[]>`
    select d.*, p.full_name as uploader_name, cd.valuation_date::text as valuation_date
    from public.documents d left join public.profiles p on p.id = d.created_by
    left join public.cas_documents cd on cd.document_id = d.id
    where d.client_id = ${clientId} and d.deleted_at is null
    order by d.created_at desc`;
}

/** How a CAS is named on screen and on download: its file name can hold the CAS password, so it is never shown. */
export function casLabel(valuationDate: string | Date | null | undefined): string {
  const d = valuationDate == null ? null : typeof valuationDate === "string" ? valuationDate.slice(0, 10) : valuationDate.toISOString().slice(0, 10);
  return d ? `CAS as of ${d}` : "CAS";
}

/** Access-checked (RLS) lookup used before issuing a signed URL. */
export async function getDocumentForDownload(tx: Tx, documentId: string): Promise<{ file_path: string; file_name: string; client_id: string }> {
  const rows = await tx<{ file_path: string; file_name: string; client_id: string; document_type: string; valuation_date: string | null }[]>`
    select d.file_path, d.file_name, d.client_id, d.document_type, cd.valuation_date::text as valuation_date
    from public.documents d left join public.cas_documents cd on cd.document_id = d.id
    where d.id = ${documentId} and d.deleted_at is null`;
  const doc = rows[0];
  if (!doc) throw new AppError("Document not found.", "NOT_FOUND");
  const fileName = doc.document_type === "CAS" ? `${casLabel(doc.valuation_date)}.pdf` : doc.file_name;
  return { file_path: doc.file_path, file_name: fileName, client_id: doc.client_id };
}

export async function registerDocument(
  tx: Tx,
  actorId: string | null,
  d: { clientId: string; type: string; filePath: string; fileName: string; mimeType: string; sizeBytes: number; sha256: string; description?: string | null; parseStatus?: string },
): Promise<string> {
  const dup = await tx<{ id: string }[]>`
    select id from public.documents
    where client_id = ${d.clientId} and document_type = ${d.type} and sha256 = ${d.sha256} and deleted_at is null`;
  if (dup[0]) throw new AppError("This file has already been uploaded for this client.", "CONFLICT");
  const rows = await tx<{ id: string }[]>`
    insert into public.documents (client_id, document_type, file_path, file_name, mime_type, size_bytes, sha256, description, parse_status, created_by)
    values (${d.clientId}, ${d.type}, ${d.filePath}, ${d.fileName}, ${d.mimeType}, ${d.sizeBytes}, ${d.sha256},
            ${d.description ?? null}, ${d.parseStatus ?? "NOT_APPLICABLE"}, ${actorId})
    returning id`;
  return rows[0].id;
}
