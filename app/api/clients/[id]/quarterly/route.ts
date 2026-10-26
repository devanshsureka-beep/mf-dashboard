import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentActor } from "@/lib/auth/session";
import { withUserTx } from "@/lib/db/tx";
import { isQuarterEnd } from "@/lib/domain/quarterly";
import { AppError, logServerError } from "@/lib/errors";
import { renderQuarterlyPdf, reviewFileName } from "@/lib/pdf/quarterly-review";
import { buildReviewFor } from "@/lib/quarterly-build";
import { objectPath, uploadAsService } from "@/lib/storage";
import { UUID_RE } from "@/lib/utils";
import { recordReviewFile } from "@/services/quarterly-review";

// Fetching a client's past NAVs the first time can take a while.
export const maxDuration = 120;

/**
 * The quarterly review PDF. `?q=<quarter-end>`; `&preview=1` opens it in the browser without keeping
 * a copy. A download (advisors and admins) is blocked while the review has errors, and every
 * downloaded PDF is kept in private storage and listed on the client's review page.
 */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/clients/[id]/quarterly">) {
  const actor = await getCurrentActor();
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const q = req.nextUrl.searchParams.get("q") ?? "";
  if (!UUID_RE.test(id) || !isQuarterEnd(q)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const preview = req.nextUrl.searchParams.get("preview") === "1";
  if (!preview && actor.role === "OPERATIONS") return NextResponse.json({ error: "Only advisors and admins download reviews." }, { status: 403 });
  const back = new URL(`/clients/${id}/quarterly?q=${q}`, req.url);
  try {
    const { report } = await buildReviewFor(actor, id, q, { fetchNavs: true });
    if (!preview && report.checks.errors.length) {
      back.searchParams.set("blocked", "1");
      return NextResponse.redirect(back, { headers: { "Cache-Control": "no-store" } });
    }
    const pdf = await renderQuarterlyPdf(report);
    const name = reviewFileName(report);
    if (!preview) {
      const sha256 = createHash("sha256").update(pdf).digest("hex");
      const path = objectPath(id, "QUARTERLY_REVIEW", { sha256, fileName: name });
      try {
        await uploadAsService(path, { bytes: pdf, sha256, fileName: name, mimeType: "application/pdf", size: pdf.length });
        await withUserTx(actor, (tx) => recordReviewFile(tx, actor, { clientId: id, quarterEnd: q, filePath: path, fileName: name, size: pdf.length, sha256, asOf: report.asOf }));
      } catch (e) {
        // The advisor still gets the PDF; the missing copy is logged.
        logServerError("quarterly-review-store", e);
      }
    }
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `${preview ? "inline" : "attachment"}; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    if (e instanceof AppError) {
      back.searchParams.set("error", e.message.slice(0, 200));
      return NextResponse.redirect(back, { headers: { "Cache-Control": "no-store" } });
    }
    logServerError("quarterly-review", e);
    return NextResponse.json({ error: "The review could not be built." }, { status: 500 });
  }
}
