import { afterAll, describe, expect, it } from "vitest";
import { issueAdvice } from "@/services/advice";
import { recordExecution } from "@/services/executions";
import { issueBulkCall } from "@/services/bulk-advice";
import { clientWithActivePlan, progress, scenario, sql, TEST_DB } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});

describeDb("One call for many clients", () => {
  it("gives each client their own call, sized on their money left, linked to their plan; skips who it cannot apply to", async () => {
    await scenario(async (ctx) => {
      const a = await clientWithActivePlan(ctx);
      const b = await clientWithActivePlan(ctx);
      // Client A sold ₹4,00,000 (executed): ₹4L left. Client B has nothing left.
      const sold = await ctx.as("advisor", (t) => issueAdvice(t, ctx.users.advisor, {
        clientId: a.clientId, communicatedAt: new Date("2026-09-10T10:30:00+05:30"), channel: "PHONE",
        items: [{ plan_item_id: a.sellItem, security_id: ctx.sec.X, action: "SELL", quantity_basis: "AMOUNT", advised_amount: 400000 }],
      }));
      await ctx.as("ops", (t) => recordExecution(t, ctx.users.ops, { adviceItemId: sold.itemIds[0], executionDate: "2026-09-11", executedAmount: 400000, verificationType: "CLIENT_CONFIRMED" }));

      const out = await ctx.as("advisor", (t) => issueBulkCall(t, ctx.users.advisor, {
        clientIds: [a.clientId, b.clientId], fundRef: `sec:${ctx.sec.Y}`, action: "BUY", mode: "PCT_MONEY_LEFT", value: 50,
        communicatedAt: new Date("2026-09-20T11:00:00+05:30"), channel: "WHATSAPP", notes: "Market dip",
      }));
      expect(out.issued).toHaveLength(1);
      expect(out.issued[0]).toMatchObject({ client_id: a.clientId, amount: 200000, plan_item_id: a.buyItem });
      expect(out.skipped).toEqual([expect.objectContaining({ client_id: b.clientId, skip: "Works out below ₹500" })]);
      // Counted against A's plan buy target (₹6,00,000).
      expect((await progress(ctx, a.buyItem)).advised_amount).toBe(200000);

      // Selling a fund a client does not hold is skipped, not sent.
      const sell = await ctx.as("advisor", (t) => issueBulkCall(t, ctx.users.advisor, {
        clientIds: [a.clientId, b.clientId], fundRef: `sec:${ctx.sec.X}`, action: "SELL", mode: "PCT_HOLDING", value: 10,
        communicatedAt: new Date("2026-09-20T11:05:00+05:30"), channel: "WHATSAPP", notes: null,
      }));
      expect(sell.issued.map((i) => i.amount)).toEqual([150000, 150000]); // 10% of 10,000 units × ₹150
    });
  });

  it("an advisor cannot include another advisor's client", async () => {
    await scenario(async (ctx) => {
      const a = await clientWithActivePlan(ctx);
      const msg = await ctx.expectError("otherAdvisor", (t) => issueBulkCall(t, ctx.users.otherAdvisor, {
        clientIds: [a.clientId], fundRef: `sec:${ctx.sec.Y}`, action: "BUY", mode: "FIXED", value: 100000,
        communicatedAt: new Date("2026-09-20T11:00:00+05:30"), channel: "PHONE", notes: null,
      }));
      expect(msg).toMatch(/not visible/);
    });
  });
});
