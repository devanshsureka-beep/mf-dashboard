import { afterAll, describe, expect, it } from "vitest";
import { issueAdvice } from "@/services/advice";
import { recordExecution } from "@/services/executions";
import { ingestNavFeed } from "@/services/nav";
import { resolveFundRef, searchFunds } from "@/services/fund-search";
import type { AmfiScheme } from "@/lib/parsers/amfi-nav";
import { clientWithActivePlan, scenario, sql, TEST_DB, type Ctx } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});

const scheme = (isin: string, nav: number, nav_date: string): AmfiScheme => ({
  isin, amfi_code: "1", scheme_name: "Feed name", amc: "Test AMC", category: "Equity Scheme - Test",
  plan_type: "DIRECT", option_type: "GROWTH", nav, nav_date,
});

async function summary(ctx: Ctx, clientId: string) {
  return (await ctx.tx<{ current_portfolio_value: number; initial_portfolio_value: number; live_portfolio_value: number; live_nav_date: string | null; money_left: number; sell_proceeds: number; buy_spent: number }[]>`
    select current_portfolio_value::float8, initial_portfolio_value::float8, live_portfolio_value::float8, live_nav_date::text,
           money_left::float8, sell_proceeds::float8, buy_spent::float8
    from public.v_client_summary where client_id = ${clientId}`)[0];
}

describeDb("Daily NAV feed, live value and money left", () => {
  it("values the latest CAS units at the newest NAV; the onboarding values never change; older feed NAVs are ignored", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx); // X: 10,000 units @ 150 on 2026-09-01
      const isin = (await ctx.tx<{ isin: string }[]>`select isin from public.security_master where id = ${ctx.sec.X}`)[0].isin;

      let s = await summary(ctx, p.clientId);
      expect(s.live_portfolio_value).toBe(1500000); // no feed yet: CAS value

      const run = await ctx.asSuper((t) => ingestNavFeed(t, { schemes: [scheme(isin, 160, "2026-09-25")], navDate: "2026-09-25" }, "test"));
      expect(run.navsUpdated).toBe(1);
      s = await summary(ctx, p.clientId);
      expect(s.live_portfolio_value).toBe(1600000);
      expect(s.live_nav_date).toBe("2026-09-25");
      expect(s.current_portfolio_value).toBe(1500000); // CAS value kept
      expect(s.initial_portfolio_value).toBe(1500000); // onboarding value fixed

      // A stale delivery never moves the NAV backwards.
      await ctx.asSuper((t) => ingestNavFeed(t, { schemes: [scheme(isin, 120, "2026-09-20")], navDate: "2026-09-20" }, "test"));
      s = await summary(ctx, p.clientId);
      expect(s.live_portfolio_value).toBe(1600000);

      // Holdings are visible to staff through RLS.
      const rows = await ctx.as("ops", (t) => t<{ is_live: boolean; nav: number }[]>`
        select is_live, nav::float8 from public.v_holding_live where client_id = ${p.clientId}`);
      expect(rows).toEqual([{ is_live: true, nav: 160 }]);
    });
  });

  it("money left = executed sells − executed buys", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx);
      const b = await ctx.as("advisor", (t) => issueAdvice(t, ctx.users.advisor, {
        clientId: p.clientId, communicatedAt: new Date("2026-09-10T10:30:00+05:30"), channel: "PHONE",
        items: [
          { plan_item_id: p.sellItem, security_id: ctx.sec.X, action: "SELL", quantity_basis: "AMOUNT", advised_amount: 300000 },
          { plan_item_id: p.buyItem, security_id: ctx.sec.Y, action: "BUY", quantity_basis: "AMOUNT", advised_amount: 200000 },
        ],
      }));
      await ctx.as("ops", (t) => recordExecution(t, ctx.users.ops, { adviceItemId: b.itemIds[0], executionDate: "2026-09-11", executedAmount: 300000, verificationType: "CLIENT_CONFIRMED" }));
      let s = await summary(ctx, p.clientId);
      expect(s.money_left).toBe(300000);
      await ctx.as("ops", (t) => recordExecution(t, ctx.users.ops, { adviceItemId: b.itemIds[1], executionDate: "2026-09-12", executedAmount: 120000, verificationType: "CLIENT_CONFIRMED" }));
      s = await summary(ctx, p.clientId);
      expect(s).toMatchObject({ sell_proceeds: 300000, buy_spent: 120000, money_left: 180000 });
    });
  });

  it("finds any AMFI fund by words in any order; a picked fund becomes a known security once", async () => {
    await scenario(async (ctx) => {
      const isin = `INFZZ${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}7`;
      await ctx.asSuper((t) => ingestNavFeed(t, {
        schemes: [{ ...scheme(isin, 42.5, "2026-09-25"), scheme_name: "Zebra Quantum Midcap Fund - Direct Plan - Growth", amc: "Zebra Mutual Fund" }],
        navDate: "2026-09-25",
      }, "test"));
      const found = await ctx.as("advisor", (t) => searchFunds(t, "midcap zebra direct"));
      expect(found[0]).toMatchObject({ value: `isin:${isin}`, nav: 42.5, amc: "Zebra Mutual Fund" });
      const id = await ctx.as("advisor", (t) => resolveFundRef(t, `isin:${isin}`, ctx.users.advisor.id));
      expect(await ctx.as("advisor", (t) => resolveFundRef(t, `isin:${isin}`, ctx.users.advisor.id))).toBe(id);
      const again = await ctx.as("ops", (t) => searchFunds(t, isin));
      expect(again.map((r) => r.value)).toEqual([`sec:${id}`]);
    });
  });
});
