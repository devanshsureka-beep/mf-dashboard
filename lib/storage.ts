import "server-only";
import { createHash } from "node:crypto";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { AppError } from "@/lib/errors";

export const BUCKET = "client-documents";
const MAX_BYTES = 25 * 1024 * 1024;
const ALLOWED = new Set(["application/pdf", "image/png", "image/jpeg", "application/json", "text/csv"]);

export interface PreparedFile {
  bytes: Buffer;
  sha256: string;
  fileName: string;
  mimeType: string;
  size: number;
}

/** Validate an uploaded File and compute its SHA-256 (used for de-duplication). */
export async function prepareUpload(file: File | null): Promise<PreparedFile> {
  if (!file || typeof file === "string" || file.size === 0) throw new AppError("Choose a file to upload.");
  if (file.size > MAX_BYTES) throw new AppError("File is larger than 25 MB.");
  const mimeType = file.type || "application/octet-stream";
  if (!ALLOWED.has(mimeType)) throw new AppError(`File type ${mimeType} is not allowed.`);
  const bytes = Buffer.from(await file.arrayBuffer());
  if (mimeType === "application/pdf" && bytes.subarray(0, 5).toString() !== "%PDF-") {
    throw new AppError("The file does not look like a valid PDF.");
  }
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), fileName: file.name, mimeType, size: file.size };
}

export function objectPath(clientId: string, type: string, f: Pick<PreparedFile, "sha256" | "fileName">): string {
  const safe = f.fileName.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-120);
  return `${clientId}/${type}/${f.sha256.slice(0, 16)}-${safe}`;
}

/**
 * Upload as the signed-in user: storage RLS policies apply (the user must have
 * access to the client in the first path segment). Objects are never overwritten.
 */
export async function uploadAsUser(path: string, f: PreparedFile): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.storage.from(BUCKET).upload(path, f.bytes, { contentType: f.mimeType, upsert: false });
  if (error && !/exists|duplicate/i.test(error.message)) throw new AppError(`Storage upload failed: ${error.message}`);
}

/** Upload from a trusted integration context (service role). */
export async function uploadAsService(path: string, f: PreparedFile): Promise<void> {
  const { error } = await createSupabaseAdminClient().storage.from(BUCKET).upload(path, f.bytes, { contentType: f.mimeType, upsert: false });
  if (error && !/exists|duplicate/i.test(error.message)) throw new AppError(`Storage upload failed: ${error.message}`);
}

/** Short-lived signed URL, generated with the USER's session (storage RLS applies). */
export async function signedUrlForUser(path: string, seconds = 60, downloadName?: string): Promise<string> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, seconds, downloadName ? { download: downloadName } : undefined);
  if (error || !data) throw new AppError("The file is not available in storage.", "NOT_FOUND");
  return data.signedUrl;
}

/** Signed URL for external processors (n8n). Service role; keep expiry short. */
export async function signedUrlForService(path: string, seconds = 600): Promise<string> {
  const { data, error } = await createSupabaseAdminClient().storage.from(BUCKET).createSignedUrl(path, seconds);
  if (error || !data) throw new AppError(`Could not sign storage URL: ${error?.message ?? "unknown"}`);
  return data.signedUrl;
}
