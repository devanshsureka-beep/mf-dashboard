/**
 * DB integration-test harness. Each scenario runs inside ONE transaction that is
 * always rolled back, so tests never leave data behind. Business calls run as a
 * real `authenticated` user (RLS + triggers apply) exactly as in the app.
 *
 * Requires TEST_DATABASE_URL pointing at a database with the migrations applied
 * (e.g. the local Supabase / Docker-less harness). Skipped otherwise.
 */
import { randomUUID } from "node:crypto";
import { createSql } from "@/lib/db/client";
import type { Actor, Tx } from "@/lib/db/tx";
import type { CasParsed } from "@/lib/integrations/contracts";
import { createClient } from "@/services/clients";
import { confirmSnapshot, createSnapshotFromParsed } from "@/services/portfolio";
import { addPlanItem, approvePlan, createDraftPlan } from "@/services/plans";

try {
  process.loadEnvFile(".env.test.local");
} catch {
  /* optional */
}

export const TEST_DB = process.env.TEST_DATABASE_URL;
export const sql = TEST_DB ? createSql(TEST_DB, 2) : null;

class Rollback extends Error {}

export interface Ctx {
  tx: Tx;
  users: Record<"admin" | "advisor" | "otherAdvisor" | "ops", Actor>;
  sec: Record<"X" | "Y" | "Z", string>;
  as<T>(who: keyof Ctx["users"], fn: (tx: Tx) => Promise<T>, reason?: string): Promise<T>;
  asSuper<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  expectError(who: keyof Ctx["users"], fn: (tx: Tx) => Promise<unknown>): Promise<string>;
}

async function setUser(tx: Tx, a: Actor | null, reason = "") {
  if (!a) {
    await tx`select set_config('role', 'postgres', true), set_config('request.jwt.claims', '', true), set_config('app.audit_reason', '', true)`;
    return;
  }
  const claims = JSON.stringify({ sub: a.id, role: "authenticated", email: a.email });
  await tx`select set_config('request.jwt.claims', ${claims}, true), set_config('role', 'authenticated', true), set_config('app.audit_reason', ${reason}, true)`;
}

export async function scenario(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  if (!sql) throw new Error("TEST_DATABASE_URL not set");
  try {
    await sql.begin(async (raw) => {
      const tx = raw as unknown as Tx;
      const mk = async (role: Actor["role"], name: string): Promise<Actor> => {
        const id = randomUUID();
        const email = `${name}.${id.slice(0, 8)}@test.invalid`;
        await tx`
          insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
          values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${email},
                  ${tx.json({ mn_role: role, mn_full_name: name, mn_active: true })}, '{}'::jsonb, now(), now())`;
        return { id, email, fullName: name, role };
      };
      const users = {
        admin: await mk("ADMIN", "Test Admin"),
        advisor: await mk("ADVISOR", "Test Advisor"),
        otherAdvisor: await mk("ADVISOR", "Other Advisor"),
        ops: await mk("OPERATIONS", "Test Ops"),
      };
      const sec = {} as Ctx["sec"];
      for (const [k, n] of [["X", "Test Regular Fund X"], ["Y", "Test Direct Fund Y"], ["Z", "Test Direct Fund Z"]] as const) {
        const isin = `INFTS${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}${k === "X" ? 1 : k === "Y" ? 2 : 3}`;
        sec[k] = (await tx<{ id: string }[]>`
          insert into public.security_master (isin, scheme_name, plan_type) values (${isin}, ${`${n} ${randomUUID().slice(0, 6)}`}, 'DIRECT') returning id`)[0].id;
      }
      const ctx: Ctx = {
        tx, users, sec,
        as: async (who, f, reason) => {
          await setUser(tx, users[who], reason);
          try {
            return await f(tx);
          } finally {
            await setUser(tx, null);
          }
        },
        asSuper: async (f) => f(tx),
        expectError: async (who, f) => {
          try {
            await (tx as unknown as { savepoint: (cb: (sp: Tx) => Promise<unknown>) => Promise<unknown> }).savepoint(async (sp) => {
              await setUser(sp, users[who]);
              await f(sp);
            });
          } catch (e) {
            await setUser(tx, null);
            return (e as Error).message;
          }
          await setUser(tx, null);
          throw new Error("Expected an error but the operation succeeded");
        },
      };
      await fn(ctx);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

export function parsed(date: string, lines: { security: string; name: string; units: number; nav: number }[], transactions: CasParsed["transactions"] = []): CasParsed {
  return {
    cas_document_id: "00000000-0000-0000-0000-000000000000",
    status: "PARSED",
    extraction_method: "DETERMINISTIC_PARSER",
    statement: { source: "CAMS", valuation_date: date },
    holdings: lines.map((l) => ({ scheme_name: l.name, units: l.units, nav: l.nav, current_value: Math.round(l.units * l.nav * 100) / 100, folio_number: "T1" })),
    transactions,
    totals: null,
    warnings: [],
  };
}

/** Client (advisor-owned) with a confirmed baseline and an ACTIVE plan:
 *  SELL X target ₹10,00,000 · BUY Y target ₹6,00,000. */
export async function clientWithActivePlan(ctx: Ctx) {
  const { tx, users, sec } = ctx;
  const client = await ctx.as("advisor", (t) => createClient(t, users.advisor, { full_name: "Test Client", status: "ACTIVE" }));
  const names = await tx<{ id: string; scheme_name: string; isin: string }[]>`select id, scheme_name, isin from public.security_master where id in (${sec.X}, ${sec.Y})`;
  const nameOf = (id: string) => names.find((n) => n.id === id)!;
  const snapshotId = await ctx.as("advisor", async (t) => {
    const p = parsed("2026-09-01", [{ security: sec.X, name: nameOf(sec.X).scheme_name, units: 10000, nav: 150 }]);
    p.holdings[0].isin = nameOf(sec.X).isin;
    const id = await createSnapshotFromParsed(t, { clientId: client.id, casDocumentId: null, parsed: p, source: "SEED", createdBy: users.advisor.id });
    await confirmSnapshot(t, id, "test");
    return id;
  });
  const planId = await ctx.as("advisor", async (t) => {
    const id = await createDraftPlan(t, users.advisor, { clientId: client.id, planName: "Test plan", fromSnapshotId: snapshotId });
    const item = (await t<{ id: string }[]>`select id from public.advisory_plan_items where plan_id = ${id} and security_id = ${sec.X}`)[0];
    await t`update public.advisory_plan_items set action = 'SELL', target_amount = 1000000 where id = ${item.id}`;
    await addPlanItem(t, users.advisor, id, { security_id: sec.Y, scheme_name: "Y", action: "BUY", target_amount: 600000 });
    await approvePlan(t, users.advisor, id, "test approval");
    return id;
  });
  const items = await tx<{ id: string; action: string }[]>`select id, action from public.advisory_plan_items where plan_id = ${planId}`;
  return {
    clientId: client.id, snapshotId, planId,
    sellItem: items.find((i) => i.action === "SELL")!.id,
    buyItem: items.find((i) => i.action === "BUY")!.id,
  };
}

export async function progress(ctx: Ctx, planItemId: string) {
  return (await ctx.tx<{ target_amount: number; advised_amount: number; executed_amount: number; pending_amount: number; yet_to_advise_amount: number; over_advised_amount: number }[]>`
    select target_amount, advised_amount, executed_amount, pending_amount, yet_to_advise_amount, over_advised_amount
    from public.v_plan_item_progress where plan_item_id = ${planItemId}`)[0];
}
