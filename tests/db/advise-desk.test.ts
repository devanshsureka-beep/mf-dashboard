import { afterAll, describe, expect, it } from "vitest";
import { issueAdvice } from "@/services/advice";
import { issueBulkCall } from "@/services/bulk-advice";
import { filterDeskRows, fundAudience, fundsMatching, listDeskRows, readyCounts } from "@/services/advise-desk";
import { clientWithActivePlan, scenario, sql, TEST_DB } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});

describeDb("Find clients: the desk and a fund's audience", () => {
  it("lists plan left, the next lines and the last tranche; a fund shows holders and plan buyers, advised or not", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx); // holds 10,000 X; SELL X ₹10L, BUY Y ₹6L

      let rows = await ctx.as("advisor", (t) => listDeskRows(t));
      let me = rows.find((r) => r.client_id === p.clientId)!;
      expect(me).toMatchObject({ sell_left: 1000000, buy_left: 600000, last_tranche_at: null, has_plan: true });
      expect(me.next.map((n) => n.action)).toEqual(["SELL", "BUY"]);
      expect(filterDeskRows(rows, { list: "sells" }).some((r) => r.client_id === p.clientId)).toBe(true);
      expect(filterDeskRows(rows, { list: "quiet", last: "never" }).some((r) => r.client_id === p.clientId)).toBe(true);
      expect(readyCounts(rows).sells.clients).toBeGreaterThanOrEqual(1);

      const x = (await ctx.tx<{ scheme_name: string }[]>`select scheme_name from public.security_master where id = ${ctx.sec.X}`)[0];
      const found = await ctx.as("advisor", (t) => fundsMatching(t, x.scheme_name));
      expect(found.find((f) => f.security_id === ctx.sec.X)).toMatchObject({ holders: 1, in_plans: 1 });

      let fx = await ctx.as("advisor", (t) => fundAudience(t, ctx.sec.X));
      let row = fx!.rows.find((r) => r.row.client_id === p.clientId)!;
      expect(row.holding?.units).toBe(10000);
      expect(row).toMatchObject({ advised: "NOT_ADVISED", plan: { side: "SELL", left: 1000000 } });
      // Y: not held, the plan buys it.
      const fy = await ctx.as("advisor", (t) => fundAudience(t, ctx.sec.Y));
      expect(fy!.rows.find((r) => r.row.client_id === p.clientId)).toMatchObject({ holding: null, advised: "NOT_ADVISED", plan: { side: "BUY" } });

      await ctx.as("advisor", (t) => issueAdvice(t, ctx.users.advisor, {
        clientId: p.clientId, communicatedAt: new Date("2026-09-05T10:00:00+05:30"), channel: "PHONE",
        items: [{ plan_item_id: p.sellItem, security_id: ctx.sec.X, action: "SELL", quantity_basis: "AMOUNT", advised_amount: 400000 }],
      }));
      fx = await ctx.as("advisor", (t) => fundAudience(t, ctx.sec.X));
      row = fx!.rows.find((r) => r.row.client_id === p.clientId)!;
      // An open call wins over what the plan still has left.
      expect(row).toMatchObject({ advised: "WAITING", open: { advised: 400000, calls: 1 } });
      rows = await ctx.as("advisor", (t) => listDeskRows(t));
      me = rows.find((r) => r.client_id === p.clientId)!;
      expect(me.last_tranche_calls).toBe(1);
      expect(me.sell_left).toBe(600000);
      expect(filterDeskRows(rows, { list: "sells", hideWaiting: true }).some((r) => r.client_id === p.clientId)).toBe(false);
    });
  });

  it("one call for many, as each plan says: each client's plan line amount, linked to it", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx); // BUY Y ₹6L in the plan
      const out = await ctx.as("advisor", (t) => issueBulkCall(t, ctx.users.advisor, {
        clientIds: [p.clientId], fundRef: `sec:${ctx.sec.Y}`, action: "BUY", mode: "PLAN", value: 0,
        communicatedAt: new Date("2026-09-05T10:00:00+05:30"), channel: "WHATSAPP", notes: null,
      }));
      expect(out.issued).toHaveLength(1);
      expect(out.issued[0]).toMatchObject({ amount: 600000, plan_item_id: p.buyItem });
      // Nothing left on the line: a second round skips the client.
      await expect(ctx.as("advisor", (t) => issueBulkCall(t, ctx.users.advisor, {
        clientIds: [p.clientId], fundRef: `sec:${ctx.sec.Y}`, action: "BUY", mode: "PLAN", value: 0,
        communicatedAt: new Date("2026-09-05T10:05:00+05:30"), channel: "WHATSAPP", notes: null,
      }))).rejects.toThrow(/every selected client was skipped/);
    });
  });
});
