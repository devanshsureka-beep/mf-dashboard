import { createHmac, randomBytes } from "node:crypto";

/**
 * Random tokens for sessions and one-time links. The browser or the email gets
 * the token; the database keeps only HMAC-SHA256(SESSION_SECRET, token), so a
 * copy of the database holds no working session or link. No Next.js imports.
 */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

function secret(): string {
  const s = process.env.SESSION_SECRET ?? "";
  if (s.length < 32) throw new Error("SESSION_SECRET is not configured (server only, at least 32 characters).");
  return s;
}

export function tokenHash(token: string): string {
  return createHmac("sha256", secret()).update(token).digest("hex");
}
