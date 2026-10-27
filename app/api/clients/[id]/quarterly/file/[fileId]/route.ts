import { NextResponse, type NextRequest } from "next/server";
import { getApiActor } from "@/lib/auth/session";
import { withUserTx } from "@/lib/db/tx";
import { AppError, logServerError } from "@/lib/errors";
import { signedUrlForUser } from "@/lib/storage";
import { UUID_RE } from "@/lib/utils";
import { getReviewFile } from "@/services/quarterly-review";

/** A quarterly review PDF downloaded earlier: a 60-second signed URL after an RLS-checked lookup. */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/clients/[id]/quarterly/file/[fileId]">) {
  const actor = await getApiActor();
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id, fileId } = await ctx.params;
  if (!UUID_RE.test(id) || !UUID_RE.test(fileId)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const f = await withUserTx(actor, (tx) => getReviewFile(tx, fileId));
    if (f.client_id !== id) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.redirect(await signedUrlForUser(f.file_path, 60, f.file_name), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof AppError) return NextResponse.json({ error: e.message }, { status: e.code === "NOT_FOUND" ? 404 : 400 });
    logServerError("quarterly-review-file", e);
    return NextResponse.json({ error: "Download failed" }, { status: 500 });
  }
}
