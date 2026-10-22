import { afterAll, describe, expect, it } from "vitest";
import { issueAdvice } from "@/services/advice";
import { getActivityMap, getClientActivity, listDeskClients } from "@/services/clients";
import { clientWithActivePlan, scenario, sql, TEST_DB } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});

describeDb("Active / inactive clients", () => {
  it("is inactive until the first call; a call recording a trade done before onboarding does not count", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx); // plan SELL X ₹10L, BUY Y ₹6L
      const call = (notes: string | null) =>
        ctx.as("advisor", (t) => issueAdvice(t, ctx.users.advisor, {
          clientId: p.clientId, communicatedAt: new Date("2026-09-10T10:00:00+05:30"), channel: "PHONE", notes,
          items: [{ plan_item_id: p.sellItem, security_id: ctx.sec.X, action: "SELL", quantity_basis: "AMOUNT", advised_amount: 100000 }],
        }));

      expect(await ctx.as("advisor", (t) => getClientActivity(t, p.clientId))).toEqual({ is_active: false, first_advised_at: null });

      await call("Done before onboarding: seen in the client's CAS");
      expect((await ctx.as("advisor", (t) => getClientActivity(t, p.clientId))).is_active).toBe(false);

      await call(null);
      const a = await ctx.as("advisor", (t) => getClientActivity(t, p.clientId));
      expect(a.is_active).toBe(true);
      expect(a.first_advised_at).not.toBeNull();

      // Lists read the same view.
      const desk = await ctx.as("advisor", (t) => listDeskClients(t, { advisorId: ctx.users.advisor.id }));
      expect(desk.find((c) => c.client_id === p.clientId)?.is_active).toBe(true);
      expect((await ctx.as("advisor", (t) => getActivityMap(t, [p.clientId])))[p.clientId]?.is_active).toBe(true);
      // Another advisor cannot see the client at all.
      expect(await ctx.as("otherAdvisor", (t) => getActivityMap(t, [p.clientId]))).toEqual({});
    });
  });
});
