import { afterAll, describe, expect, it } from "vitest";
import { buildQuarterlyReport } from "@/lib/domain/quarterly-report";
import { issueAdvice } from "@/services/advice";
import { gatherReview, getQuarterContext, recordReviewFile, saveFundBenchmark, saveMarketContext, saveReviewInputs } from "@/services/quarterly-review";
import { approveLine } from "@/services/waiting-approve";
import { clientWithActivePlan, scenario, sql, TEST_DB, type Ctx } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});

/** Funds X and Y priced by the daily feed, with past NAVs; the Nifty 50 index fund with its own. */
async function prices(ctx: Ctx) {
  await ctx.asSuper(async (t) => {
    const s = await t<{ id: string; isin: string; scheme_name: string }[]>`select id, isin, scheme_name from public.security_master where id in (${ctx.sec.X}, ${ctx.sec.Y})`;
    const x = s.find((r) => r.id === ctx.sec.X)!;
    const y = s.find((r) => r.id === ctx.sec.Y)!;
    await t`update public.security_master set amfi_code = case id when ${ctx.sec.X} then '990001' else '990002' end where id in (${ctx.sec.X}, ${ctx.sec.Y})`;
    await t`insert into public.mf_schemes (isin, amfi_code, scheme_name, category, plan_type, option_type, nav, nav_date) values
      (${x.isin}, '990001', ${x.scheme_name}, 'Equity Scheme - Mid Cap Fund', 'DIRECT', 'GROWTH', 160, '2026-10-09'),
      (${y.isin}, '990002', ${y.scheme_name}, 'Equity Scheme - Large Cap Fund', 'DIRECT', 'GROWTH', 105, '2026-10-09')
      on conflict (isin) do update set nav = excluded.nav, nav_date = excluded.nav_date, category = excluded.category, amfi_code = excluded.amfi_code`;
    const rows = [
      ["990001", "2026-09-01", 150], ["990001", "2026-09-12", 155], ["990001", "2026-10-09", 160],
      ["990002", "2026-09-01", 100], ["990002", "2026-09-15", 100], ["990002", "2026-10-09", 105],
      ["119063", "2026-08-25", 200], ["119063", "2026-09-15", 200], ["119063", "2026-10-09", 204],
      ["147666", "2026-08-25", 300], ["147666", "2026-09-15", 300], ["147666", "2026-10-09", 303],
    ].map(([c, d, n]) => ({ amfi_code: c, nav_date: d, nav: n }));
    await t`insert into public.nav_history ${t(rows)} on conflict do nothing`;
  });
}

describeDb("Quarterly review", () => {
  it("builds every page from the client's numbers, with the advisor's inputs and checks", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx); // CAS 01-Sep: X 10,000 units @150; plan SELL X ₹10L, BUY Y ₹6L
      await prices(ctx);
      const call = (planItem: string, sec: string, action: "SELL" | "BUY", amount: number) =>
        ctx.as("advisor", (t) => issueAdvice(t, ctx.users.advisor, {
          clientId: p.clientId, communicatedAt: new Date("2026-09-10T10:00:00+05:30"), channel: "PHONE",
          items: [{ plan_item_id: planItem, security_id: sec, action, quantity_basis: "AMOUNT", advised_amount: amount }],
        }));
      const sell = (await call(p.sellItem, ctx.sec.X, "SELL", 400000)).itemIds[0];
      const buy = (await call(p.buyItem, ctx.sec.Y, "BUY", 100000)).itemIds[0];
      await ctx.as("advisor", (t) => approveLine(t, ctx.users.advisor, p.clientId, { kind: "CALL", id: sell, choice: "DONE", date: "2026-09-12" }, "2026-10-22"));
      await ctx.as("advisor", (t) => approveLine(t, ctx.users.advisor, p.clientId, { kind: "CALL", id: buy, choice: "DONE", date: "2026-09-15" }, "2026-10-22"));

      await ctx.as("advisor", (t) => saveMarketContext(t, ctx.users.advisor, "2026-09-30", { rows: [{ index: "Nifty 50", peNow: 19.3, median: 22 }], note: "Large caps look cheap." }));
      const raw = await ctx.as("advisor", (t) => gatherReview(t, p.clientId, "2026-09-30", { otherClientNames: ["Someone Else"], navFailed: [] }));
      expect(raw).toMatchObject({ casDate: "2026-09-01", asOf: "2026-10-09", windowStart: "2026-09-10", reviewNo: 1 });
      const r = buildQuarterlyReport(raw, {});

      // Book: 10,000 X at today's 160 (the approved sale is not in the CAS units yet).
      expect(r.totals.value).toBeCloseTo(1600000);
      expect(r.money).toMatchObject({ deployed: 100000, recycled: 400000 });
      // New money: ₹1L into Y at 100 → 1,000 units × 105. Nifty 50: ₹1L at 200 → 500 × 204.
      expect(r.score.rows).toEqual([expect.objectContaining({ newIn: 100000, worth: 105000, index: "Nifty 100" })]);
      expect(r.score.rows[0].ahead).toBeCloseTo(105000 - 101000);
      expect(r.money.niftyWorth).toBeCloseTo(102000);
      expect(r.money.aheadOfNifty).toBeCloseTo(3000);
      // Sold X: 400000/155 units, worth today at 160.
      expect(r.old!.worthIfKept).toBeCloseTo((400000 / 155) * 160);
      expect(r.plan.rows.map((x) => x.status)).toEqual(["PARTLY", "PARTLY"]);
      expect(r.rebalance).toMatchObject({ redeemed: 600000, reinvested: 500000 });
      expect(r.market.valuations[0]).toMatchObject({ index: "Nifty 50", read: "CHEAP" });
      expect(r.texts.marketNote).toBe("Large caps look cheap.");
      expect(r.checks.errors).toEqual([]);
      expect(r.checks.warnings.join(" ")).toMatch(/Fund status not set/);

      // Inputs: saved, then read back; a forbidden term blocks the download; the index can be overridden.
      await ctx.as("advisor", (t) => saveReviewInputs(t, ctx.users.advisor, p.clientId, "2026-09-30", { headline: "Passed every MF Bomb gate", funds: { [ctx.sec.X]: { status: "AMBER", why: "Watch it" } } }));
      const q = await ctx.as("advisor", (t) => getQuarterContext(t, p.clientId, "2026-09-30"));
      const r2 = buildQuarterlyReport(raw, q.inputs);
      expect(r2.checks.errors.join(" ")).toMatch(/MF Bomb/);
      expect(r2.health[0]).toMatchObject({ status: "AMBER", why: "Watch it" });
      const isinY = (await ctx.asSuper((t) => t<{ isin: string }[]>`select isin from public.security_master where id = ${ctx.sec.Y}`))[0].isin;
      await ctx.as("advisor", (t) => saveFundBenchmark(t, ctx.users.advisor, isinY, "NIFTY50"));
      const raw3 = await ctx.as("advisor", (t) => gatherReview(t, p.clientId, "2026-09-30", { otherClientNames: [], navFailed: [] }));
      expect(buildQuarterlyReport(raw3, {}).score.rows[0].index).toBe("Nifty 50");
      await ctx.as("advisor", (t) => saveFundBenchmark(t, ctx.users.advisor, isinY, ""));

      // A download is kept; the next quarter starts after it and carries the fund statuses over.
      await ctx.as("advisor", (t) => recordReviewFile(t, ctx.users.advisor, { clientId: p.clientId, quarterEnd: "2026-09-30", filePath: `${p.clientId}/QUARTERLY_REVIEW/x.pdf`, fileName: "x.pdf", size: 10, sha256: "a".repeat(64), asOf: "2026-10-09" }));
      const next = await ctx.as("advisor", (t) => getQuarterContext(t, p.clientId, "2026-12-31"));
      expect(next.carriedFrom).toBe("2026-09-30");
      expect(next.inputs.funds?.[ctx.sec.X]?.status).toBe("AMBER");
      // Operations cannot write a review; another advisor cannot see it.
      expect(await ctx.expectError("ops", (t) => saveReviewInputs(t, ctx.users.ops, p.clientId, "2026-09-30", {}))).toMatch(/row-level security|permission/i);
      expect((await ctx.as("otherAdvisor", (t) => getQuarterContext(t, p.clientId, "2026-09-30"))).reviewId).toBeNull();
    });
  });
});
