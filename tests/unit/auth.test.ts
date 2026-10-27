import { describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { hashPassword, passwordProblem, verifyPassword } from "@/lib/auth/password";
import { newToken, tokenHash } from "@/lib/auth/tokens";
import { authMode } from "@/lib/auth/mode";

describe("in-app sign-in helpers", () => {
  it("hashes passwords as bcrypt cost 10, the format Supabase Auth reads", async () => {
    const h = await hashPassword("a-long-password-1");
    expect(h).toMatch(/^\$2[aby]\$10\$/);
    expect(await verifyPassword("a-long-password-1", h)).toBe(true);
    // A hash written by another bcrypt (as Supabase Auth stores them) is accepted too.
    expect(await verifyPassword("from-supabase", bcrypt.hashSync("from-supabase", 10).replace(/^\$2b\$/, "$2a$"))).toBe(true);
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
  });

  it("checks new passwords", () => {
    expect(passwordProblem("short")).toMatch(/12 characters/);
    expect(passwordProblem("rohan.mehta-2026!", "rohan.mehta@example.com")).toMatch(/email/);
    expect(passwordProblem("x".repeat(73))).toMatch(/72/);
    expect(passwordProblem("a perfectly fine one")).toBeNull();
  });

  it("stores only a keyed hash of each token, and needs a real secret", () => {
    const before = process.env.SESSION_SECRET;
    try {
      process.env.SESSION_SECRET = "short";
      expect(() => tokenHash("t")).toThrow(/SESSION_SECRET/);
      process.env.SESSION_SECRET = "a".repeat(32);
      const t = newToken();
      expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(tokenHash(t)).toMatch(/^[0-9a-f]{64}$/);
      expect(tokenHash(t)).not.toContain(t);
      const h1 = tokenHash(t);
      process.env.SESSION_SECRET = "b".repeat(32);
      expect(tokenHash(t)).not.toBe(h1);
    } finally {
      process.env.SESSION_SECRET = before;
    }
  });

  it("defaults to Supabase Auth unless AUTH_MODE=app", () => {
    const before = process.env.AUTH_MODE;
    try {
      delete process.env.AUTH_MODE;
      expect(authMode()).toBe("supabase");
      process.env.AUTH_MODE = "APP";
      expect(authMode()).toBe("supabase");
      process.env.AUTH_MODE = "app";
      expect(authMode()).toBe("app");
    } finally {
      process.env.AUTH_MODE = before;
    }
  });
});
