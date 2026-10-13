import { afterAll, describe, expect, it } from "vitest";
import { issueAdvice } from "@/services/advice";
import { recordExecution } from "@/services/executions";
import { getFundRows, getTranches } from "@/services/client-desk";
import { clientWithActivePlan, progress, scenario, sql, TEST_DB } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});

describeDb("Client page: funds and tranches", () => {
  it("shows per-fund plan progress with dates, from the views, and puts calls in the open tranche", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx); // SELL X ₹10L, BUY Y ₹6L, CAS of 01-Sep
      const call = await ctx.as("advisor", (t) => issueAdvice(t, ctx.users.advisor, {
        clientId: p.clientId, communicatedAt: new Date("2026-09-10T10:00:00+05:30"), channel: "PHONE",
        items: [{ plan_item_id: p.sellItem, security_id: ctx.sec.X, action: "SELL", quantity_basis: "AMOUNT", advised_amount: 300000 }],
      }));
      await ctx.as("ops", (t) => recordExecution(t, ctx.users.ops, {
        adviceItemId: call.itemIds[0], executionDate: "2026-09-12", executedAmount: 250000, executedUnits: null, verificationType: "CLIENT_CONFIRMED",
      }));

      const { rows, totals } = await ctx.as("advisor", (t) => getFundRows(t, p.clientId));
      const x = rows.find((r) => r.securityId === ctx.sec.X)!;
      const y = rows.find((r) => r.securityId === ctx.sec.Y)!;
      const v = await progress(ctx, p.sellItem);
      expect(x.plan).toMatchObject({ tone: "sell", advised: v.advised_amount, executed: v.executed_amount, pending: v.pending_amount, remaining: v.yet_to_advise_amount });
      expect(x.advisedDates).toEqual(["10-Sep"]);
      expect(x.executedDates).toEqual(["12-Sep"]);
      expect(x.events.map((e) => e.kind)).toEqual(expect.arrayContaining(["PLAN", "CALL", "EXECUTED"]));
      expect(x.onboardingValue).toBe(1500000);
      expect(y).toMatchObject({ notHeld: true, plan: { tone: "buy", remaining: 600000 } });
      expect(rows[0].securityId).toBe(ctx.sec.X); // sells first
      expect(totals).toMatchObject({ sellTarget: 1000000, buyTarget: 600000, executed: 250000 });

      const { tranches, ledger, baseline } = await ctx.as("advisor", (t) => getTranches(t, p.clientId));
      expect(baseline?.date).toBe("2026-09-01");
      expect(tranches).toHaveLength(1);
      expect(tranches[0]).toMatchObject({ number: 1, open: true, calls: 1, advisedSell: 300000, executedSell: 250000, pending: 50000 });
      expect(ledger[0]).toMatchObject({ tranche: 1, advisedOn: "2026-09-10", executed: 250000, executedOn: "2026-09-12" });
    });
  });
});
