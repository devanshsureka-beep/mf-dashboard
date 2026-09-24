import "server-only";
import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import type { z } from "zod";
import { AppError, logServerError } from "@/lib/errors";

const MAX_JSON_BYTES = 5 * 1024 * 1024;

/** Constant-time check of "Authorization: Bearer <INTEGRATION_API_KEY>". */
export function verifyIntegrationRequest(req: NextRequest): NextResponse | null {
  const expected = process.env.INTEGRATION_API_KEY;
  if (!expected || expected.length < 24) {
    return NextResponse.json({ error: "Integration API is not configured (INTEGRATION_API_KEY)." }, { status: 503 });
  }
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

/** Read + validate a JSON body. Nothing is written unless this succeeds. */
export async function readJson<T extends z.ZodType>(req: NextRequest, schema: T): Promise<{ data: z.infer<T> } | { response: NextResponse }> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_JSON_BYTES) return { response: NextResponse.json({ error: "Payload too large" }, { status: 413 }) };
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return { response: NextResponse.json({ error: "Body must be valid JSON" }, { status: 400 }) };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return {
      response: NextResponse.json(
        { error: "Validation failed", issues: parsed.error.issues.slice(0, 50).map((i) => ({ path: i.path.join("."), message: i.message })) },
        { status: 422 },
      ),
    };
  }
  return { data: parsed.data };
}

export function integrationError(context: string, e: unknown): NextResponse {
  if (e instanceof AppError) {
    const status = e.code === "NOT_FOUND" ? 404 : e.code === "CONFLICT" ? 409 : e.code === "FORBIDDEN" ? 403 : 422;
    return NextResponse.json({ error: e.message }, { status });
  }
  logServerError(`integration:${context}`, e);
  return NextResponse.json({ error: "Internal error" }, { status: 500 });
}
