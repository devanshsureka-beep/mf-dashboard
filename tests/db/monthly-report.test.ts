import { afterAll, describe, expect, it } from "vitest";
import { issueAdvice } from "@/services/advice";
import { recordExecution } from "@/services/executions";
import { getMonthlyReport, monthBounds } from "@/services/monthly-report";
import { clientWithActivePlan, scenario, sql, TEST_DB } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});

describe("monthBounds", () => {
  it("gives the first and last day and a label", () => {
    expect(monthBounds("2026-02")).toEqual({ start: "2026-02-01", end: "2026-02-28", label: "February 2026" });
    expect(() => monthBounds("2026-13x")).toThrow();
  });
});

describeDb("Monthly client report", () => {
  it("lists the month's calls and executions and the portfolio at the start and end of the month", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx); // baseline CAS 2026-09-01 (X 10,000 units @150)
      const call = await ctx.as("advisor", (t) => issueAdvice(t, ctx.users.advisor, {
        clientId: p.clientId, communicatedAt: new Date("2026-09-10T10:00:00+05:30"), channel: "PHONE",
        items: [{ plan_item_id: p.sellItem, security_id: ctx.sec.X, action: "SELL", quantity_basis: "AMOUNT", advised_amount: 300000 }],
      }));
      await ctx.as("ops", (t) => recordExecution(t, ctx.users.ops, {
        adviceItemId: call.itemIds[0], executionDate: "2026-09-12", executedAmount: 200000, executedUnits: null, verificationType: "CLIENT_CONFIRMED",
      }));
      const r = await ctx.as("advisor", (t) => getMonthlyReport(t, p.clientId, "2026-09"));
      expect(r.label).toBe("September 2026");
      expect(r.calls).toHaveLength(1);
      expect(r.totals).toMatchObject({ advised: 300000, advisedSell: 300000, executed: 200000, executedSell: 200000, callCount: 1 });
      expect(r.startValue).toBeNull();
      expect(r.endValue).toMatchObject({ date: "2026-09-01", value: 1500000 });
      expect(r.categories.reduce((t, c) => t + c.weight, 0)).toBeCloseTo(1, 5);
      const empty = await ctx.as("advisor", (t) => getMonthlyReport(t, p.clientId, "2026-08"));
      expect(empty.calls).toHaveLength(0);
      expect(empty.endValue).toBeNull();
    });
  });
});
