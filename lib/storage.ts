import "server-only";
import { createHash, randomUUID } from "node:crypto";
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

/*
 * Large files skip the app server: Vercel refuses a request body over 4.5 MB
 * before the app sees it. The browser asks for a one-time signed upload link,
 * puts the file straight into storage under staging/<user>/, and the form
 * sends only that path. The action then reads (and removes) the staged file.
 */
const STAGING = "staging";

export async function createStagedUpload(userId: string): Promise<{ path: string; url: string }> {
  const path = `${STAGING}/${userId}/${randomUUID()}.bin`;
  const { data, error } = await createSupabaseAdminClient().storage.from(BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw new AppError(`Could not prepare the upload: ${error?.message ?? "no link"}`);
  return { path, url: data.signedUrl };
}

async function currentUserId(): Promise<string> {
  const { data } = await (await createSupabaseServerClient()).auth.getUser();
  if (!data.user) throw new AppError("Sign in again to upload.", "FORBIDDEN");
  return data.user.id;
}

async function takeStagedUpload(path: string, fileName: string, mimeType: string): Promise<PreparedFile> {
  const userId = await currentUserId();
  // Only the signed-in user's own staged files, by the exact shape we hand out.
  if (!new RegExp(`^${STAGING}/${userId}/[0-9a-f-]{36}\\.bin$`).test(path)) throw new AppError("The uploaded file was not found. Choose it again.");
  const store = createSupabaseAdminClient().storage.from(BUCKET);
  const { data, error } = await store.download(path);
  if (error || !data) throw new AppError("The uploaded file was not found. Choose it again.");
  await store.remove([path]);
  return prepareUpload(new File([await data.arrayBuffer()], fileName, { type: mimeType }));
}

/** The form's file `name`: sent in the request, or staged in storage by the browser (large files). */
export async function fileFromForm(fd: FormData, name: string): Promise<PreparedFile> {
  const staged = fd.get(`${name}__staged`);
  if (typeof staged === "string" && staged) {
    return takeStagedUpload(staged, String(fd.get(`${name}__name`) || "upload.pdf"), String(fd.get(`${name}__type`) || "application/pdf"));
  }
  return prepareUpload(fd.get(name) as File | null);
}

/** Whether the form carries a non-empty file `name` (sent or staged). */
export function formHasFile(fd: FormData, name: string): boolean {
  const f = fd.get(name);
  return Boolean(fd.get(`${name}__staged`)) || (f instanceof File && f.size > 0);
}

/** The original file name of the form's file `name`. */
export function formFileName(fd: FormData, name: string): string {
  const f = fd.get(name);
  return f instanceof File ? f.name : String(fd.get(`${name}__name`) || "file");
}

export function objectPath(clientId: string, type: string, f: Pick<PreparedFile, "sha256" | "fileName">): string {
  // CAS file names often hold the CAS password: never put them in the path.
  if (type === "CAS") return `${clientId}/CAS/${f.sha256.slice(0, 16)}.pdf`;
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

/** Read a stored file with the USER's session (storage RLS applies). */
export async function downloadAsUser(path: string): Promise<Uint8Array> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  if (error || !data) throw new AppError("The file is not available in storage.", "NOT_FOUND");
  return new Uint8Array(await data.arrayBuffer());
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

/**
 * Client exports (ZIP of everything about a client) live in their own private
 * bucket with no user policies: only the server writes them, after the
 * RLS-checked export was built, and hands out a short signed URL. Earlier
 * exports of the same client are removed so copies don't pile up.
 */
export const EXPORT_BUCKET = "client-exports";

export async function storeClientExport(clientId: string, bytes: Uint8Array, downloadName: string): Promise<string> {
  const store = createSupabaseAdminClient().storage.from(EXPORT_BUCKET);
  const old = await store.list(clientId);
  if (old.data?.length) await store.remove(old.data.map((o) => `${clientId}/${o.name}`));
  const path = `${clientId}/${Date.now()}.zip`;
  const up = await store.upload(path, bytes, { contentType: "application/zip", upsert: true });
  if (up.error) throw new AppError(`Could not store the export: ${up.error.message}`);
  const { data, error } = await store.createSignedUrl(path, 300, { download: downloadName });
  if (error || !data) throw new AppError(`Could not sign the export URL: ${error?.message ?? "unknown"}`);
  return data.signedUrl;
}
