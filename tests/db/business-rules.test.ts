import { afterAll, describe, expect, it } from "vitest";
import { closeAdvice, issueAdvice, reviseAdvice } from "@/services/advice";
import { recordExecution, voidExecution } from "@/services/executions";
import { ingestAdvisoryReport, approvePlan } from "@/services/plans";
import { clientWithActivePlan, progress, scenario, sql, TEST_DB, type Ctx } from "./harness";

const T0 = new Date("2026-09-10T10:42:00+05:30");
const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});

async function call(ctx: Ctx, clientId: string, planItemId: string, securityId: string, action: "SELL" | "BUY", amount: number, units?: number) {
  const out = await ctx.as("advisor", (t) => issueAdvice(t, ctx.users.advisor, {
    clientId, communicatedAt: T0, channel: "PHONE",
    items: [{ plan_item_id: planItemId, security_id: securityId, action, quantity_basis: units ? "UNITS" : "AMOUNT", advised_amount: amount, advised_units: units ?? null }],
  }));
  return out.itemIds[0];
}
const exec = (ctx: Ctx, who: "advisor" | "ops", adviceItemId: string, amount: number, units?: number) =>
  ctx.as(who, (t) => recordExecution(t, ctx.users[who], {
    adviceItemId, executionDate: "2026-09-12", executedAmount: amount, executedUnits: units ?? null, verificationType: "CLIENT_CONFIRMED",
  }));

describeDb("Plan → Advice → Execution arithmetic (database views)", () => {
  it("target − advised = yet to advise; advised − executed = pending (multiple calls, multiple executions)", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx);
      const a1 = await call(ctx, p.clientId, p.sellItem, ctx.sec.X, "SELL", 300000);
      const a2 = await call(ctx, p.clientId, p.sellItem, ctx.sec.X, "SELL", 200000);
      await exec(ctx, "advisor", a1, 100000);
      await exec(ctx, "ops", a1, 200000);     // a1 fully executed via two executions
      await exec(ctx, "ops", a2, 50000);      // a2 partial
      const v = await progress(ctx, p.sellItem);
      expect(v).toMatchObject({ target_amount: 1000000, advised_amount: 500000, executed_amount: 350000, pending_amount: 150000, yet_to_advise_amount: 500000 });
      expect(v.target_amount - v.advised_amount).toBe(v.yet_to_advise_amount);
      expect(v.advised_amount - v.executed_amount).toBe(v.pending_amount);
      const st = await ctx.tx<{ id: string; status: string }[]>`select id, status from public.advice_items where id in (${a1}, ${a2})`;
      expect(Object.fromEntries(st.map((s) => [s.id, s.status]))).toEqual({ [a1]: "EXECUTED", [a2]: "PARTIALLY_EXECUTED" });
    });
  });

  it("cancelled advice counts only what was executed before cancellation", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx);
      const a = await call(ctx, p.clientId, p.sellItem, ctx.sec.X, "SELL", 400000);
      await exec(ctx, "ops", a, 100000);
      await ctx.as("advisor", (t) => closeAdvice(t, a, "CANCELLED", "Client changed mind"));
      expect(await progress(ctx, p.sellItem)).toMatchObject({ advised_amount: 100000, executed_amount: 100000, pending_amount: 0, yet_to_advise_amount: 900000 });
    });
  });

  it("revised advice: original stays (REVISED), only the new total counts", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx);
      const a = await call(ctx, p.clientId, p.sellItem, ctx.sec.X, "SELL", 500000);
      const r = await ctx.as("advisor", (t) => reviseAdvice(t, ctx.users.advisor, {
        adviceItemId: a, newTotalAmount: 300000, reason: "Market condition changed", communicatedAt: T0, channel: "PHONE",
      }));
      expect(await progress(ctx, p.sellItem)).toMatchObject({ advised_amount: 300000, pending_amount: 300000, yet_to_advise_amount: 700000 });
      const rows = await ctx.tx<{ id: string; status: string; advised_amount: number; revises_advice_item_id: string | null }[]>`
        select id, status, advised_amount, revises_advice_item_id from public.advice_items where id in (${a}, ${r.newItemId}) order by created_at`;
      expect(rows.map((x) => [x.status, x.advised_amount])).toEqual([["REVISED", 500000], ["ISSUED", 300000]]);
      expect(rows[1].revises_advice_item_id).toBe(a);
      // Audit trail keeps original (₹5L), revision and reason.
      const audit = await ctx.tx<{ reason: string; old_value: { advised_amount: number; status: string }; new_value: { status: string } }[]>`
        select reason, old_value, new_value from public.audit_logs where entity_id = ${a} and action = 'UPDATE'`;
      expect(audit[0]).toMatchObject({ reason: "Market condition changed", old_value: { advised_amount: 500000, status: "ISSUED" }, new_value: { status: "REVISED" } });
    });
  });

  it("revision of a partly executed call carries only the remainder (no double counting)", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx);
      const a = await call(ctx, p.clientId, p.sellItem, ctx.sec.X, "SELL", 500000);
      await exec(ctx, "ops", a, 100000);
      await ctx.as("advisor", (t) => reviseAdvice(t, ctx.users.advisor, {
        adviceItemId: a, newTotalAmount: 300000, reason: "Reduce", communicatedAt: T0, channel: "WHATSAPP",
      }));
      expect(await progress(ctx, p.sellItem)).toMatchObject({ advised_amount: 300000, executed_amount: 100000, pending_amount: 200000, yet_to_advise_amount: 700000 });
    });
  });

  it("unit-based call: 200 + 300 of 500 units becomes EXECUTED", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx);
      const a = await call(ctx, p.clientId, p.sellItem, ctx.sec.X, "SELL", 75000, 500);
      await exec(ctx, "ops", a, 30300, 200);
      let s = await ctx.tx<{ status: string; pending_units: number }[]>`select status, pending_units from public.v_advice_items where id = ${a}`;
      expect(s[0]).toMatchObject({ status: "PARTIALLY_EXECUTED", pending_units: 300 });
      await exec(ctx, "ops", a, 45600, 300);
      s = await ctx.tx`select status, pending_units from public.v_advice_items where id = ${a}`;
      expect(s[0].status).toBe("EXECUTED");
      expect((await progress(ctx, p.sellItem)).pending_amount).toBe(0);
    });
  });

  it("never produces negative remainders when a call exceeds the plan or executions exceed the call", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx);
      const a = await call(ctx, p.clientId, p.buyItem, ctx.sec.Y, "BUY", 650000); // plan target 6L
      await ctx.as("ops", (t) => recordExecution(t, ctx.users.ops, {
        adviceItemId: a, executionDate: "2026-09-12", executedAmount: 700000, verificationType: "CLIENT_CONFIRMED", allowOverExecution: true,
      }));
      const v = await progress(ctx, p.buyItem);
      expect(v.yet_to_advise_amount).toBe(0);
      expect(v.pending_amount).toBe(0);
      expect(v.over_advised_amount).toBe(100000);
      expect(v.advised_amount).toBe(v.executed_amount + v.pending_amount);
    });
  });

  it("voiding an execution re-derives the call status (history kept)", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx);
      const a = await call(ctx, p.clientId, p.sellItem, ctx.sec.X, "SELL", 100000);
      const e = await exec(ctx, "ops", a, 100000);
      expect(e.adviceStatus).toBe("EXECUTED");
      await ctx.as("ops", (t) => voidExecution(t, e.executionId, "REJECTED", "Order failed at AMC"));
      const s = await ctx.tx<{ status: string }[]>`select status from public.advice_items where id = ${a}`;
      expect(s[0].status).toBe("ISSUED");
      expect((await ctx.tx`select count(*)::int as n from public.executions where advice_item_id = ${a}`)[0].n).toBe(1);
    });
  });
});

describeDb("Immutability, reasons and permissions", () => {
  it("advice amounts, timestamps and executions cannot be silently changed or deleted", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx);
      const a = await call(ctx, p.clientId, p.sellItem, ctx.sec.X, "SELL", 100000);
      expect(await ctx.expectError("advisor", (t) => t`update public.advice_items set advised_amount = 1 where id = ${a}`)).toMatch(/immutable/);
      expect(await ctx.expectError("admin", (t) => t`update public.advice_batches set communicated_at = now() - interval '1 day' where id = (select advice_batch_id from public.advice_items where id = ${a})`)).toMatch(/immutable/);
      expect(await ctx.expectError("admin", (t) => t`delete from public.advice_items where id = ${a}`)).toMatch(/cannot be deleted|permission denied/);
      expect(await ctx.expectError("advisor", (t) => t`update public.advice_items set status = 'CANCELLED' where id = ${a}`)).toMatch(/reason is required/);
      const e = await exec(ctx, "ops", a, 50000);
      expect(await ctx.expectError("ops", (t) => t`update public.executions set executed_amount = 1 where id = ${e.executionId}`)).toMatch(/immutable/);
      expect(await ctx.expectError("admin", (t) => t`delete from public.audit_logs where true`)).toMatch(/append-only|permission denied/);
    });
  });

  it("ACTIVE plan amendments require a reason; approved targets are frozen", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx);
      expect(await ctx.expectError("advisor", (t) => t`update public.advisory_plan_items set target_amount = 5 where id = ${p.sellItem}`)).toMatch(/requires a reason/);
      await ctx.as("advisor", (t) => t`update public.advisory_plan_items set target_amount = 800000 where id = ${p.sellItem}`, "Market rally, trim less");
      const plan = await ctx.tx<{ target_exit_value: number; approved_target_exit_value: number }[]>`select target_exit_value, approved_target_exit_value from public.advisory_plans where id = ${p.planId}`;
      expect(plan[0]).toEqual({ target_exit_value: 800000, approved_target_exit_value: 1000000 });
      expect(await ctx.expectError("advisor", (t) => t`update public.advisory_plans set approved_target_exit_value = 1 where id = ${p.planId}`)).toMatch(/immutable/);
    });
  });

  it("RLS: other advisors cannot see the client; operations cannot issue advice but can record executions", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx);
      const seen = await ctx.as("otherAdvisor", (t) => t`select id from public.clients where id = ${p.clientId}`);
      expect(seen).toHaveLength(0);
      const seenViews = await ctx.as("otherAdvisor", (t) => t`select * from public.v_client_summary where client_id = ${p.clientId}`);
      expect(seenViews).toHaveLength(0);
      expect(await ctx.expectError("ops", (t) => issueAdvice(t, ctx.users.ops, {
        clientId: p.clientId, communicatedAt: T0, channel: "PHONE",
        items: [{ security_id: ctx.sec.X, action: "SELL", quantity_basis: "AMOUNT", advised_amount: 1000 }],
      }))).toMatch(/row-level security/);
      const a = await call(ctx, p.clientId, p.sellItem, ctx.sec.X, "SELL", 100000);
      await expect(exec(ctx, "ops", a, 100000)).resolves.toMatchObject({ adviceStatus: "EXECUTED" });
      expect(await ctx.expectError("otherAdvisor", (t) => t`update public.profiles set role = 'ADMIN' where id = ${ctx.users.otherAdvisor.id}`)).toMatch(/Only an admin/);
    });
  });

  it("AI-extracted plans are DRAFT and cannot be approved while lines need review", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx);
      const code = (await ctx.tx<{ client_code: string }[]>`select client_code from public.clients where id = ${p.clientId}`)[0].client_code;
      const out = await ctx.as("advisor", (t) => ingestAdvisoryReport(t, {
        client_code: code, status: "PARSED", plan: { plan_name: "Extracted" }, warnings: [],
        items: [{ action: "BUY", scheme_name: "Totally Unknown Fund", target_amount: 1000 }], sip_items: [],
      }, ctx.users.advisor.id));
      const plan = await ctx.tx<{ status: string }[]>`select status from public.advisory_plans where id = ${out.planId}`;
      expect(plan[0].status).toBe("DRAFT");
      expect(out.itemsNeedingReview).toBe(1);
      expect(await ctx.expectError("advisor", (t) => approvePlan(t, ctx.users.advisor, out.planId!, "try"))).toMatch(/resolved security|needs review/);
      expect(await ctx.expectError("advisor", (t) => t`insert into public.advisory_plans (client_id, plan_name, status, created_by) values (${p.clientId}, 'x', 'ACTIVE', ${ctx.users.advisor.id})`)).toMatch(/created as DRAFT/);
    });
  });
});
