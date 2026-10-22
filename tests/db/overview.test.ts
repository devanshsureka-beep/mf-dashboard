import { afterAll, describe, expect, it } from "vitest";
import { issueAdvice } from "@/services/advice";
import { getOverview } from "@/services/overview";
import { approveLine } from "@/services/waiting-approve";
import { clientWithActivePlan, scenario, sql, TEST_DB } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});

describeDb("Overview", () => {
  it("adds up plan numbers, idle cash, monthly money and trades with proof for the advisor's clients", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx); // plan SELL X ₹10L, BUY Y ₹6L
      const call = (planItem: string, sec: string, action: "SELL" | "BUY", amount: number) =>
        ctx.as("advisor", (t) => issueAdvice(t, ctx.users.advisor, {
          clientId: p.clientId, communicatedAt: new Date("2026-09-10T10:00:00+05:30"), channel: "PHONE",
          items: [{ plan_item_id: planItem, security_id: sec, action, quantity_basis: "AMOUNT", advised_amount: amount }],
        }));
      const sell = (await call(p.sellItem, ctx.sec.X, "SELL", 400000)).itemIds[0];
      await call(p.buyItem, ctx.sec.Y, "BUY", 100000);
      await ctx.as("advisor", (t) => approveLine(t, ctx.users.advisor, p.clientId, { kind: "CALL", id: sell, choice: "DONE", date: "2026-09-12" }, "2026-10-22"));

      const o = await ctx.as("advisor", (t) => getOverview(t, { advisorId: ctx.users.advisor.id, from: "2026-08-01", to: "2026-10-22" }));
      expect(o.kpis.clients).toBe(1);
      expect(o.kpis.sell).toEqual({ target: 1000000, executed: 400000, waiting: 0, notAdvised: 600000 });
      expect(o.kpis.buy).toEqual({ target: 600000, executed: 0, waiting: 100000, notAdvised: 500000 });
      expect(o.kpis.idle).toEqual({ amount: 400000, clients: 1 });

      const row = o.book.find((b) => b.client_id === p.clientId)!;
      expect(row).toMatchObject({ sold: 400000, sell_pending: 600000, bought: 0, buy_pending: 600000, idle: 400000 });
      expect(row.status.label).toMatch(/Behind|Waiting/);
      expect(row.next).toMatch(/Ask for CAS|Approve 1 waiting call/);

      expect(o.months.map((m) => m.month)).toEqual(["2026-10", "2026-09", "2026-08"]);
      expect(o.months.find((m) => m.month === "2026-09")).toMatchObject({ sell_clients: 1, sell: 400000, buy_clients: 0, buy: 0 });
      expect(o.txns.filter((t) => t.client_id === p.clientId)).toEqual([
        expect.objectContaining({ date: "2026-09-12", side: "SELL", amount: 400000, proof: "APPROVED" }),
      ]);

      // Another advisor sees none of it.
      const other = await ctx.as("otherAdvisor", (t) => getOverview(t, { advisorId: ctx.users.otherAdvisor.id, from: "2026-08-01", to: "2026-10-22" }));
      expect(other.book.find((b) => b.client_id === p.clientId)).toBeUndefined();
    });
  });
});
