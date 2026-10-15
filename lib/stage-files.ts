import { stageUploadAction } from "@/app/(app)/upload-actions";

/** Vercel refuses request bodies over 4.5 MB; keep a margin for the other fields. */
const DIRECT_LIMIT = 3.5 * 1024 * 1024;

export class StageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StageError";
  }
}

/**
 * When a form's files are too large to send through the app server, put each
 * one straight into storage and send its path instead (the server reads it
 * with fileFromForm). Small uploads are left as they are.
 */
export async function stageLargeFiles(fd: FormData): Promise<void> {
  const files = [...fd.entries()].filter((e): e is [string, File] => e[1] instanceof File && e[1].size > 0);
  if (files.reduce((s, [, f]) => s + f.size, 0) <= DIRECT_LIMIT) return;
  for (const [name, f] of files) {
    // Several files under one field cannot be staged one by one; say so instead of hitting the 4.5 MB wall.
    if (fd.getAll(name).length > 1) throw new StageError("These files are too large to send together (over 3.5 MB). Upload them one at a time.");
    const s = await stageUploadAction(f.size);
    if (!s.ok) throw new StageError(s.error);
    const r = await fetch(s.url, { method: "PUT", body: f, headers: { "content-type": f.type || "application/octet-stream" } });
    if (!r.ok) throw new StageError(`Uploading ${f.name} to storage failed (${r.status}). Nothing was saved; please try again.`);
    fd.delete(name);
    fd.set(`${name}__staged`, s.path);
    fd.set(`${name}__name`, f.name);
    fd.set(`${name}__type`, f.type);
  }
}
