import { NextResponse, type NextRequest } from "next/server";
import { withSystemTx } from "@/lib/db/tx";
import { integrationError, verifyIntegrationRequest } from "@/lib/integrations/auth";
import { parseAmfiNav } from "@/lib/parsers/amfi-nav";
import { ingestNavFeed } from "@/services/nav";

// ~15,000 schemes per file; bulk upserts finish well within this.
export const maxDuration = 60;

const MAX_BYTES = 8 * 1024 * 1024;

/**
 * POST /api/integrations/nav-update
 * Body: the AMFI NAVAll.txt file as text/plain (exactly as downloaded from
 * https://www.amfiindia.com/spages/NAVAll.txt). Called daily by n8n.
 * Optional ?source=<label>. Re-sending the same file is harmless.
 */
export async function POST(req: NextRequest) {
  const denied = verifyIntegrationRequest(req);
  if (denied) return denied;
  try {
    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > MAX_BYTES) return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    const text = await req.text();
    if (text.length > MAX_BYTES) return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    const feed = parseAmfiNav(text);
    if (feed.schemes.length < 100) {
      return NextResponse.json({ error: "This does not look like the AMFI NAV file (fewer than 100 schemes).", schemes: feed.schemes.length }, { status: 422 });
    }
    const source = (req.nextUrl.searchParams.get("source") ?? "n8n:amfi").slice(0, 60);
    const result = await withSystemTx("integration:nav-feed", (tx) => ingestNavFeed(tx, feed, source));
    return NextResponse.json({ ok: true, ...result, skippedLines: feed.skipped });
  } catch (e) {
    return integrationError("nav-update", e);
  }
}
