import { isIP } from "node:net";

/**
 * The visitor's IP from X-Forwarded-For, trusting only what OUR proxies added.
 *
 * Each proxy appends the address it received the request from, and a client can put anything at the
 * start of the header, so the first entry is never trusted. `trustedEntries` (TRUSTED_PROXY_ENTRIES)
 * is how many entries our own infrastructure appends at the END of the header, counting the client's:
 *   - one proxy that appends the client address (nginx, Vercel, Cloud Run alone): 1
 *   - Google Cloud external HTTP(S) load balancer: "<supplied>, <client-ip>, <load-balancer-ip>": 2
 * The client is then the entry that many places from the end. Unset or invalid: no IP (null), never a
 * guess, because a wrong guess (e.g. the load balancer's own address) would put every user in one
 * rate-limit bucket. No Next.js imports (unit-tested).
 */
export function clientIp(forwardedFor: string | null | undefined, trustedEntries: number): string | null {
  if (!forwardedFor || !Number.isInteger(trustedEntries) || trustedEntries < 1) return null;
  const parts = forwardedFor.split(",").map((s) => s.trim()).filter(Boolean);
  // Shorter than our proxies add: the request did not come through them as configured.
  if (parts.length < trustedEntries) return null;
  const ip = parts[parts.length - trustedEntries];
  return isIP(ip) ? ip : null;
}
