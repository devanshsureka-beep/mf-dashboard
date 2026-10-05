import { afterAll, describe, expect, it } from "vitest";
import { issueAdvice } from "@/services/advice";
import { correctAdvice, correctExecution } from "@/services/corrections";
import { recordExecution } from "@/services/executions";
import { clientWithActivePlan, progress, scenario, sql, TEST_DB } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});

describeDb("Admin corrections of calls and executions", () => {
  it("an admin corrects a call and its execution with a reason; others cannot; the plan numbers follow", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx); // SELL X ₹10L
      const call = await ctx.as("advisor", (t) => issueAdvice(t, ctx.users.advisor, {
        clientId: p.clientId, communicatedAt: new Date("2026-09-10T10:00:00+05:30"), channel: "PHONE",
        items: [{ plan_item_id: p.sellItem, security_id: ctx.sec.X, action: "SELL", quantity_basis: "AMOUNT", advised_amount: 30000 }],
      }));
      const itemId = call.itemIds[0];
      const ex = await ctx.as("ops", (t) => recordExecution(t, ctx.users.ops, {
        adviceItemId: itemId, executionDate: "2026-09-11", executedAmount: 30000, executedUnits: null, verificationType: "CLIENT_CONFIRMED",
      }));
      expect((await progress(ctx, p.sellItem)).executed_amount).toBe(30000);

      const fix = {
        advisedAmount: 300000, advisedUnits: null, quantityBasis: "AMOUNT" as const, referencePrice: null,
        planItemId: p.sellItem, securityId: ctx.sec.X, communicatedAt: new Date("2026-09-10T09:30:00+05:30"), channel: "WHATSAPP" as const,
        reason: "typo: ₹3L was advised, not ₹30K",
      };
      // Advisors cannot correct, and the database refuses a direct change.
      await expect(ctx.as("advisor", (t) => correctAdvice(t, ctx.users.advisor, itemId, fix))).rejects.toThrow(/Only an admin/);
      expect(await ctx.expectError("advisor", (t) => t`update public.advice_items set advised_amount = 1 where id = ${itemId}`)).toMatch(/immutable/);
      // An admin without a reason is refused too.
      await expect(ctx.as("admin", (t) => correctAdvice(t, ctx.users.admin, itemId, { ...fix, reason: " " }))).rejects.toThrow(/reason/);

      await ctx.as("admin", (t) => correctAdvice(t, ctx.users.admin, itemId, fix));
      const a = (await ctx.tx<{ advised_amount: number; status: string; communicated_at: Date; communication_channel: string }[]>`
        select ai.advised_amount::float8, ai.status, b.communicated_at, b.communication_channel
        from public.advice_items ai join public.advice_batches b on b.id = ai.advice_batch_id where ai.id = ${itemId}`)[0];
      expect(a).toMatchObject({ advised_amount: 300000, status: "PARTIALLY_EXECUTED", communication_channel: "WHATSAPP" });
      expect(new Date(a.communicated_at).toISOString()).toBe("2026-09-10T04:00:00.000Z");
      let pr = await progress(ctx, p.sellItem);
      expect(pr.advised_amount).toBe(300000);
      expect(pr.pending_amount).toBe(270000);

      // The execution was for the full ₹3L.
      await ctx.as("admin", (t) => correctExecution(t, ctx.users.admin, ex.executionId, {
        executedAmount: 300000, executedUnits: 2000, executionDate: "2026-09-11", executionPrice: 150, reason: "statement shows ₹3L",
      }));
      pr = await progress(ctx, p.sellItem);
      expect(pr.executed_amount).toBe(300000);
      expect(pr.pending_amount).toBe(0);
      expect((await ctx.tx<{ status: string }[]>`select status from public.advice_items where id = ${itemId}`)[0].status).toBe("EXECUTED");

      // Both corrections are in the audit log with the reason.
      const audit = await ctx.tx<{ entity_type: string }[]>`
        select entity_type from public.audit_logs where entity_id in (${itemId}, ${ex.executionId}) and reason like 'Admin correction:%'`;
      expect(audit.map((x) => x.entity_type)).toEqual(expect.arrayContaining(["advice_items", "executions"]));
    });
  });
});
