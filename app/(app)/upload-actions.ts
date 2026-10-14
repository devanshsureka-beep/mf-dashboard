"use server";

import { requireActorForAction } from "@/lib/auth/session";
import { AppError } from "@/lib/errors";
import { ALL_ROLES } from "@/lib/server";
import { createStagedUpload } from "@/lib/storage";

export type StageResult = { ok: true; path: string; url: string } | { ok: false; error: string };

/** A one-time link for the browser to put a large file straight into storage (see lib/storage.ts). */
export async function stageUploadAction(size: number): Promise<StageResult> {
  try {
    const actor = await requireActorForAction(ALL_ROLES);
    if (!(size > 0)) return { ok: false, error: "Choose a file to upload." };
    if (size > 25 * 1024 * 1024) return { ok: false, error: "File is larger than 25 MB." };
    return { ok: true, ...(await createStagedUpload(actor.id)) };
  } catch (e) {
    return { ok: false, error: e instanceof AppError ? e.message : "Could not prepare the upload. Please try again." };
  }
}
