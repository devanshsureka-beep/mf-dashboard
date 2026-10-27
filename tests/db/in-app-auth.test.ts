import { afterAll, describe, expect, it } from "vitest";
import { createSql } from "@/lib/db/client";
import { asServer, withSystemTx, withUserTx, type Tx } from "@/lib/db/tx";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import {
  consumeLinkToken, createAuthUser, findLoginUser, insertLinkToken, insertSession, lockAccountForSignIn, peekLinkToken, recordAttempt,
  revokeSessions, sessionUser, setPassword, setSignInAllowed, signInLocked,
} from "@/services/auth-users";
import { scenario, sql, TEST_DB } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});

const unique = () => Math.random().toString(36).slice(2, 10);

async function newUser(tx: Tx, role: "ADMIN" | "ADVISOR" | "OPERATIONS" = "ADVISOR", password = "correct-horse-battery") {
  const email = `auth.${unique()}@test.invalid`;
  const id = await createAuthUser(tx, { email, fullName: "Auth Test", role, passwordHash: await hashPassword(password) });
  return { id, email };
}

describeDb("in-app sign-in (AUTH_MODE=app)", () => {
  it("creates an account the way Supabase Auth does: user, email identity and profile with the role", async () => {
    await scenario(async ({ tx }) => {
      const u = await newUser(tx, "OPERATIONS");
      const [row] = await tx<{ aud: string; role: string; confirmed: boolean; ident: number; prole: string; active: boolean; tokens_empty: boolean }[]>`
        select u.aud, u.role, u.email_confirmed_at is not null as confirmed,
          (select count(*)::int from auth.identities i where i.user_id = u.id and i.provider = 'email' and i.provider_id = u.id::text) as ident,
          p.role as prole, p.is_active as active, u.confirmation_token = '' and u.recovery_token = '' as tokens_empty
        from auth.users u join public.profiles p on p.id = u.id where u.id = ${u.id}`;
      expect(row).toEqual({ aud: "authenticated", role: "authenticated", confirmed: true, ident: 1, prole: "OPERATIONS", active: true, tokens_empty: true });
      const found = await findLoginUser(tx, u.email.toUpperCase());
      expect(found).toMatchObject({ id: u.id, blocked: null, role: "OPERATIONS" });
      expect(await verifyPassword("correct-horse-battery", found!.encrypted_password)).toBe(true);
      expect(await verifyPassword("wrong-password-1", found!.encrypted_password)).toBe(false);
      expect(await verifyPassword("anything", null)).toBe(false);
    });
  });

  it("a session ends on expiry, idle time, a ban, removal from the team or sign-out everywhere", async () => {
    await scenario(async ({ tx }) => {
      const u = await newUser(tx);
      const start = async (h: string) => insertSession(tx, { tokenHash: h, userId: u.id, ip: "1.2.3.4", userAgent: "test" });
      await start("h-live");
      expect(await sessionUser(tx, "h-live")).toMatchObject({ id: u.id, role: "ADVISOR", must_change_password: false });
      expect(await sessionUser(tx, "h-unknown")).toBeNull();

      await start("h-expired");
      await tx`update app.sessions set expires_at = now() - interval '1 second' where token_hash = 'h-expired'`;
      expect(await sessionUser(tx, "h-expired")).toBeNull();

      await start("h-idle");
      await tx`update app.sessions set last_seen_at = now() - interval '9 hours' where token_hash = 'h-idle'`;
      expect(await sessionUser(tx, "h-idle")).toBeNull();

      await setSignInAllowed(tx, u.id, false);
      expect(await sessionUser(tx, "h-live")).toBeNull();
      expect(await tx`select 1 from app.sessions where user_id = ${u.id}`).toHaveLength(0);
      expect((await findLoginUser(tx, u.email))?.blocked).toBe("BANNED");
      await setSignInAllowed(tx, u.id, true);
      expect((await findLoginUser(tx, u.email))?.blocked).toBeNull();

      await start("h-a");
      await start("h-b");
      await revokeSessions(tx, u.id, "h-b");
      expect(await sessionUser(tx, "h-a")).toBeNull();
      expect(await sessionUser(tx, "h-b")).not.toBeNull();

      await tx`update public.profiles set is_active = false, removed_at = now() where id = ${u.id}`;
      expect(await sessionUser(tx, "h-b")).toBeNull();
      expect((await findLoginUser(tx, u.email))?.blocked).toBe("REMOVED");
    });
  });

  it("a new password (or a temporary one) signs the user out everywhere", async () => {
    await scenario(async ({ tx }) => {
      const u = await newUser(tx);
      await insertSession(tx, { tokenHash: "h-pw", userId: u.id, ip: null, userAgent: null });
      await setPassword(tx, u.id, await hashPassword("a-temporary-pass"), true);
      expect(await sessionUser(tx, "h-pw")).toBeNull();
      const found = await findLoginUser(tx, u.email);
      expect(found?.must_change_password).toBe(true);
      expect(await verifyPassword("a-temporary-pass", found!.encrypted_password)).toBe(true);
    });
  });

  it("locks an email after 5 failures in 15 minutes; a success clears it; other emails are not affected", async () => {
    await scenario(async ({ tx }) => {
      const email = `lock.${unique()}@test.invalid`;
      const ip = `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
      for (let i = 0; i < 4; i++) await recordAttempt(tx, email, ip, false);
      expect(await signInLocked(tx, email, ip)).toBe(false);
      await recordAttempt(tx, email, ip, false);
      expect(await signInLocked(tx, email, ip)).toBe(true);
      expect(await signInLocked(tx, `other.${unique()}@test.invalid`, null)).toBe(false);
      await tx`update app.login_attempts set at = at - interval '16 minutes' where email = ${email}`;
      expect(await signInLocked(tx, email, ip)).toBe(false);
      for (let i = 0; i < 5; i++) await recordAttempt(tx, email, ip, false);
      await recordAttempt(tx, email, ip, true);
      expect(await signInLocked(tx, email, null)).toBe(false);
    });
  });

  it("an outsider cannot lock a colleague out: the lock is per account and IP, refused attempts do not count, a new password clears it", async () => {
    await scenario(async ({ tx }) => {
      const u = await newUser(tx);
      const attacker = "203.0.113.9", office = "198.51.100.7";
      for (let i = 0; i < 5; i++) await recordAttempt(tx, u.email, attacker, false);
      expect(await signInLocked(tx, u.email, attacker)).toBe(true);
      // The real user from another IP still gets in.
      expect(await signInLocked(tx, u.email, office)).toBe(false);
      // Refused attempts are not recorded, so hammering a locked account changes nothing.
      const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from app.login_attempts where email = ${u.email}`;
      expect(n).toBe(5);
      // Many IPs: the account-wide limit (20) applies everywhere.
      for (let i = 0; i < 15; i++) await recordAttempt(tx, u.email, `192.0.2.${i}`, false);
      expect(await signInLocked(tx, u.email, office)).toBe(true);
      // A password reset or an admin's temporary password clears it.
      await setPassword(tx, u.id, await hashPassword("a-new-password-1"), false);
      expect(await signInLocked(tx, u.email, office)).toBe(false);
      expect(await signInLocked(tx, u.email, attacker)).toBe(false);
    });
  });

  it("a new password or a removal cancels every open link", async () => {
    await scenario(async ({ tx }) => {
      const u = await newUser(tx);
      await insertLinkToken(tx, u.id, "t-inv", "INVITE");
      await insertLinkToken(tx, u.id, "t-res", "RESET");
      expect(await consumeLinkToken(tx, "t-res")).not.toBeNull();
      await setPassword(tx, u.id, await hashPassword("a-new-password-1"), false);
      expect(await peekLinkToken(tx, "t-inv")).toBeNull();
      await insertLinkToken(tx, u.id, "t-later", "RESET");
      await setSignInAllowed(tx, u.id, false);
      expect(await peekLinkToken(tx, "t-later")).toBeNull();
    });
  });

  it("a user cannot clear their own forced password change or removal (direct Data API access)", async () => {
    await scenario(async (ctx) => {
      await ctx.tx`update public.profiles set must_change_password = true where id = ${ctx.users.advisor.id}`;
      expect(await ctx.expectError("advisor", (t) => t`update public.profiles set must_change_password = false where id = ${ctx.users.advisor.id}`)).toMatch(/Only an admin/);
      expect(await ctx.expectError("advisor", (t) => t`update public.profiles set removed_at = now(), is_active = false where id = ${ctx.users.advisor.id}`)).toMatch(/Only an admin/);
    });
  });

  it("a reset or invite link works once, and not after it expires or a newer one is sent", async () => {
    await scenario(async ({ tx }) => {
      const u = await newUser(tx);
      await insertLinkToken(tx, u.id, "t-1", "RESET");
      expect(await peekLinkToken(tx, "t-1")).toMatchObject({ user_id: u.id, purpose: "RESET", email: u.email });
      expect(await consumeLinkToken(tx, "t-1")).toMatchObject({ user_id: u.id });
      expect(await consumeLinkToken(tx, "t-1")).toBeNull();

      await insertLinkToken(tx, u.id, "t-2", "INVITE");
      await insertLinkToken(tx, u.id, "t-3", "INVITE");
      expect(await consumeLinkToken(tx, "t-2")).toBeNull();
      await tx`update app.auth_tokens set expires_at = now() - interval '1 second' where token_hash = 't-3'`;
      expect(await peekLinkToken(tx, "t-3")).toBeNull();
      expect(await consumeLinkToken(tx, "t-3")).toBeNull();
    });
  });

  it("signed-in users cannot read sessions, attempts or links", async () => {
    await scenario(async (ctx) => {
      for (const table of ["app.sessions", "app.login_attempts", "app.auth_tokens"]) {
        const err = await ctx.expectError("admin", (t) => t.unsafe(`select count(*) from ${table}`));
        expect(err).toMatch(/permission denied/);
      }
    });
  });

  it("an admin action can write auth.users as the server and then runs as the user again", async () => {
    await scenario(async (ctx) => {
      const u = await newUser(ctx.tx);
      await ctx.as("admin", async (t) => {
        await asServer(t, () => setSignInAllowed(t, u.id, false));
        const [me] = await t<{ who: string; uid: string }[]>`select current_user as who, auth.uid()::text as uid`;
        expect(me).toEqual({ who: "authenticated", uid: ctx.users.admin.id });
      });
      expect((await findLoginUser(ctx.tx, u.email))?.blocked).toBe("BANNED");
      // Without asServer the user role cannot touch auth.users.
      expect(await ctx.expectError("admin", (t) => t`update auth.users set banned_until = null where id = ${u.id}`)).toMatch(/permission denied/);
    });
  });

  it("parallel sign-ins for one email wait for each other", async () => {
    const a = createSql(TEST_DB!, 1), b = createSql(TEST_DB!, 1);
    try {
      const email = `race.${unique()}@test.invalid`;
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      const first = a.begin(async (tx) => {
        await lockAccountForSignIn(tx as unknown as Tx, email);
        await held;
      });
      await new Promise((r) => setTimeout(r, 200));
      const second = await b.begin(async (tx) => {
        await tx`set local lock_timeout = '300ms'`;
        return lockAccountForSignIn(tx as unknown as Tx, email).then(() => "got it", (e: Error) => e.message);
      }).catch((e: Error) => e.message);
      expect(second).toMatch(/lock timeout/);
      release();
      await first;
      const third = await b.begin(async (tx) => lockAccountForSignIn(tx as unknown as Tx, email).then(() => "got it"));
      expect(third).toBe("got it");
    } finally {
      await a.end();
      await b.end();
    }
  });

  it("who the user is stays inside the transaction: the pooled connection does not keep it", async () => {
    // One connection, as the pool may hand the same one to consecutive requests. Nothing is written.
    const one = createSql(TEST_DB!, 1);
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    const whoAmI = (tx: Tx) => tx<{ who: string; uid: string | null }[]>`select current_user as who, auth.uid()::text as uid`;
    try {
      const [a] = await withUserTx({ id: ids[0] }, whoAmI, { sql: one });
      expect(a).toEqual({ who: "authenticated", uid: ids[0] });
      // Outside any transaction, nothing is left on the connection.
      const [between] = await one<{ who: string; claims: string | null }[]>`select current_user as who, nullif(current_setting('request.jwt.claims', true), '') as claims`;
      expect(between.claims).toBeNull();
      expect(between.who).not.toBe("authenticated");
      // The server's own transaction runs as no user.
      const [sys] = await withSystemTx("test", whoAmI, { sql: one });
      expect(sys.uid).toBeNull();
      expect(sys.who).not.toBe("authenticated");
      // The next request is the next user only.
      const [b] = await withUserTx({ id: ids[1] }, whoAmI, { sql: one });
      expect(b).toEqual({ who: "authenticated", uid: ids[1] });
      // A transaction that fails still leaves nothing behind.
      await withUserTx({ id: ids[0] }, async (tx) => { await tx`select 1/0`; }, { sql: one }).catch(() => null);
      const [after] = await one<{ claims: string | null }[]>`select nullif(current_setting('request.jwt.claims', true), '') as claims`;
      expect(after.claims).toBeNull();
    } finally {
      await one.end();
    }
  });
});
