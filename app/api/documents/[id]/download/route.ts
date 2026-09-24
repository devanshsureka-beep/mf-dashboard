import { NextResponse, type NextRequest } from "next/server";
import { getCurrentActor } from "@/lib/auth/session";
import { withUserTx } from "@/lib/db/tx";
import { AppError, logServerError } from "@/lib/errors";
import { signedUrlForUser } from "@/lib/storage";
import { getDocumentForDownload } from "@/services/documents";

/** Redirects to a 60-second signed URL after an RLS-checked lookup. */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/documents/[id]/download">) {
  const actor = await getCurrentActor();
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  try {
    const doc = await withUserTx(actor, (tx) => getDocumentForDownload(tx, id));
    const url = await signedUrlForUser(doc.file_path, 60, doc.file_name);
    return NextResponse.redirect(url, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof AppError) return NextResponse.json({ error: e.message }, { status: e.code === "NOT_FOUND" ? 404 : 400 });
    logServerError("document-download", e);
    return NextResponse.json({ error: "Download failed" }, { status: 500 });
  }
}
