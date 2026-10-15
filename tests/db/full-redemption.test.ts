import { afterAll, describe, expect, it } from "vitest";
import { issueAdvice } from "@/services/advice";
import { addSipItem, adviseSipStops } from "@/services/plans";
import { getSipStatus } from "@/services/sip-status";
import { clientWithActivePlan, progress, scenario, sql, TEST_DB } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});

describeDb("Full redemption from the Issue call page", () => {
  it("a full exit is a UNITS call for every unit held; SIP stops are STOP lines advised once", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx); // holds 10,000 units of X; SELL X ₹10L
      // "Full" on the sell line: all 10,000 units, valued at the NAV.
      await ctx.as("advisor", (t) => issueAdvice(t, ctx.users.advisor, {
        clientId: p.clientId, communicatedAt: new Date("2026-09-05T10:00:00+05:30"), channel: "PHONE",
        items: [{ plan_item_id: p.sellItem, security_id: ctx.sec.X, action: "SELL", quantity_basis: "UNITS", advised_amount: 1500000, advised_units: 10000, reference_price: 150 }],
      }));
      const call = (await ctx.tx<{ quantity_basis: string; advised_units: number }[]>`
        select quantity_basis, advised_units::float8 from public.advice_items where plan_item_id = ${p.sellItem}`)[0];
      expect(call).toMatchObject({ quantity_basis: "UNITS", advised_units: 10000 });
      expect((await progress(ctx, p.sellItem)).advised_amount).toBeGreaterThan(0);

      // A STOP the report already planned is reused, not duplicated; a second redemption adds nothing.
      const planned = await ctx.as("advisor", (t) => addSipItem(t, ctx.users.advisor, p.planId,
        { security_id: ctx.sec.Y, scheme_name: "Y", action: "STOP", old_amount: 5000 }, "report says stop"));
      const stops = [{ security_id: ctx.sec.Y, scheme_name: "Y", amount: 5000 }, { security_id: ctx.sec.X, scheme_name: "X", amount: 2500 }];
      expect(await ctx.as("advisor", (t) => adviseSipStops(t, ctx.users.advisor, p.clientId, stops, "told on call"))).toBe(2);
      expect(await ctx.as("advisor", (t) => adviseSipStops(t, ctx.users.advisor, p.clientId, stops, "told again"))).toBe(0);
      const lines = await ctx.tx<{ id: string; security_id: string; status: string }[]>`
        select id, security_id, status from public.sip_plan_items where plan_id = ${p.planId} and action = 'STOP' order by created_at`;
      expect(lines).toHaveLength(2);
      expect(lines.every((l) => l.status === "ADVISED")).toBe(true);
      expect(lines[0].id).toBe(planned);
    });
  });

  it("SIPs the report keeps unchanged show in the SIP section", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx);
      // Fixture only: the payload is fixed once a plan is approved, so set it with the guard triggers paused.
      await ctx.tx`set local session_replication_role = replica`;
      await ctx.tx`update public.advisory_plans set extraction_payload = jsonb_build_object('unchanged_sips',
        jsonb_build_array(jsonb_build_object('isin', null, 'scheme_name', 'Kept Fund', 'amount', 3000))) where id = ${p.planId}`;
      await ctx.tx`set local session_replication_role = origin`;
      const seen = await ctx.as("advisor", (t) => getSipStatus(t, p.clientId));
      expect(seen.continuing).toEqual([{ isin: null, scheme_name: "Kept Fund", amount: 3000 }]);
    });
  });
});
