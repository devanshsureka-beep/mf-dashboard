import { afterAll, describe, expect, it } from "vitest";
import { issueAdvice } from "@/services/advice";
import { filterDeskRows, listDeskRows } from "@/services/advise-desk";
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
      const desk0 = await ctx.as("advisor", (t) => listDeskRows(t));
      expect(filterDeskRows(desk0, { list: "all", act: "inactive" }).some((r) => r.client_id === p.clientId)).toBe(true);
      expect(filterDeskRows(desk0, { list: "all", act: "active" }).some((r) => r.client_id === p.clientId)).toBe(false);

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
      const desk1 = await ctx.as("advisor", (t) => listDeskRows(t));
      expect(filterDeskRows(desk1, { list: "all", act: "active" }).some((r) => r.client_id === p.clientId)).toBe(true);
      expect(filterDeskRows(desk1, { list: "all", act: "inactive" }).some((r) => r.client_id === p.clientId)).toBe(false);
      // Another advisor cannot see the client at all.
      expect(await ctx.as("otherAdvisor", (t) => getActivityMap(t, [p.clientId]))).toEqual({});
    });
  });
});

describeDb("Active / inactive clients · SIP", () => {
  it("an advised SIP line makes the client active; a SIP line the CAS ticked straight from the report does not", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx);
      await ctx.tx`select set_config('app.audit_reason', 'test SIP line', true)`;
      await ctx.tx`
        insert into public.sip_plan_items (client_id, plan_id, security_id, scheme_name, action, new_amount, status, advised_at, completed_at)
        values (${p.clientId}, ${p.planId}, ${ctx.sec.Y}, 'Y SIP', 'START', 10000, 'COMPLETED', '2026-09-10T10:00:00+05:30', '2026-09-10T10:00:00+05:30')`;
      expect((await ctx.as("advisor", (t) => getClientActivity(t, p.clientId))).is_active).toBe(false);

      await ctx.tx`select set_config('app.audit_reason', 'test SIP line', true)`;
      await ctx.tx`
        insert into public.sip_plan_items (client_id, plan_id, security_id, scheme_name, action, new_amount, status, advised_at)
        values (${p.clientId}, ${p.planId}, ${ctx.sec.X}, 'X SIP', 'START', 5000, 'ADVISED', '2026-09-12T10:00:00+05:30')`;
      const a = await ctx.as("advisor", (t) => getClientActivity(t, p.clientId));
      expect(a.is_active).toBe(true);
      expect(a.first_advised_at?.slice(0, 10)).toBe("2026-09-12");
    });
  });
});
