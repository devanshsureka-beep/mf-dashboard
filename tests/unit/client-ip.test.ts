import { describe, expect, it } from "vitest";
import { clientIp } from "@/lib/auth/client-ip";

describe("client IP behind our own proxies", () => {
  it("takes the entry our proxies added, never one the client supplied", () => {
    // Google Cloud load balancer: "<supplied>, <client-ip>, <load-balancer-ip>".
    expect(clientIp("203.0.113.9, 198.51.100.7, 34.120.0.1", 2)).toBe("198.51.100.7");
    // A client faking its address at the start changes nothing.
    expect(clientIp("1.2.3.4, 9.9.9.9, 198.51.100.7, 34.120.0.1", 2)).toBe("198.51.100.7");
    // One proxy that appends the client address.
    expect(clientIp("198.51.100.7", 1)).toBe("198.51.100.7");
    expect(clientIp("1.2.3.4, 198.51.100.7", 1)).toBe("198.51.100.7");
    expect(clientIp("2001:db8::1, 34.120.0.1", 2)).toBe("2001:db8::1");
  });

  it("gives no IP rather than a guess", () => {
    expect(clientIp(null, 1)).toBeNull();
    expect(clientIp("", 1)).toBeNull();
    expect(clientIp("198.51.100.7", Number.NaN)).toBeNull(); // TRUSTED_PROXY_ENTRIES unset
    expect(clientIp("198.51.100.7", 0)).toBeNull();
    expect(clientIp("198.51.100.7", 2)).toBeNull(); // header shorter than our proxies add
    expect(clientIp("not-an-ip, 34.120.0.1", 2)).toBeNull();
  });
});
