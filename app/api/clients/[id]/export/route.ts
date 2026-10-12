import { NextResponse, type NextRequest } from "next/server";
import { getCurrentActor } from "@/lib/auth/session";
import { withUserTx } from "@/lib/db/tx";
import { AppError, logServerError } from "@/lib/errors";
import { downloadAsUser, storeClientExport } from "@/lib/storage";
import { buildZip, toCsv, type ZipEntry } from "@/lib/zip";
import { exportReadme, gatherClientExport } from "@/services/client-export";

export const maxDuration = 300;

// Responses above ~4 MB can't come straight from a serverless function; those
// are stored privately and served through a short signed URL instead.
const DIRECT_LIMIT = 4 * 1024 * 1024;

/** Everything about one client as a ZIP: all records as CSV plus every stored file. */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/clients/[id]/export">) {
  const actor = await getCurrentActor();
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  try {
    const data = await withUserTx(actor, (tx) => gatherClientExport(tx, id));
    const entries: ZipEntry[] = data.tables.map((t) => ({ name: `data/${t.file}`, data: toCsv(t.columns, t.rows) }));
    const missing: string[] = [];
    for (const f of data.files) {
      try {
        entries.push({ name: f.zipName, data: await downloadAsUser(f.path), date: f.uploadedAt });
      } catch {
        missing.push(f.zipName);
      }
    }
    entries.unshift({ name: "README.txt", data: exportReadme(data, actor.fullName ?? actor.email, missing) });
    const zip = buildZip(entries);
    const stamp = new Date().toISOString().slice(0, 10);
    const name = `${data.client.client_code} ${data.client.full_name} - everything ${stamp}.zip`.replace(/[\\/:*?"<>|]+/g, "_");
    if (zip.length <= DIRECT_LIMIT) {
      return new NextResponse(zip as unknown as BodyInit, {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
          "Cache-Control": "no-store",
        },
      });
    }
    return NextResponse.redirect(await storeClientExport(data.client.id, zip, name), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof AppError) return NextResponse.json({ error: e.message }, { status: e.code === "NOT_FOUND" ? 404 : 400 });
    logServerError("client-export", e);
    return NextResponse.json({ error: "Export failed" }, { status: 500 });
  }
}
