import { afterAll, describe, expect, it } from "vitest";
import { confirmSnapshot, createSnapshotFromParsed } from "@/services/portfolio";
import { setSipStatus } from "@/services/plans";
import { convertBuyToSip, convertSipToLumpsum, getClientSip, getSipProgress, updateSipAmounts } from "@/services/sip";
import { clientWithActivePlan, parsed, progress, scenario, sql, TEST_DB } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});

describeDb("SIP alongside lump sums", () => {
  it("a lump-sum buy becomes a SIP; only instalments seen in CAS count as invested; a SIP can go back to lump sum", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx); // BUY Y ₹6L lump sum
      const y = (await ctx.tx<{ scheme_name: string; isin: string }[]>`select scheme_name, isin from public.security_master where id = ${ctx.sec.Y}`)[0];

      // ₹2.4L of the ₹6L buy moves to a ₹20,000/month SIP (amount entered by the advisor).
      const { sipItemId } = await ctx.as("advisor", (t) => convertBuyToSip(t, ctx.users.advisor, p.buyItem, {
        monthlyAmount: 20000, lumpsumAmount: 240000, debitDay: 5, reason: "client prefers SIP",
      }));
      expect((await progress(ctx, p.buyItem)).target_amount).toBe(360000);
      let sip = await ctx.as("advisor", (t) => getClientSip(t, p.clientId));
      expect(sip).toMatchObject({ sip_monthly_target: 20000, sip_monthly_advised: 0, sip_monthly_yet_to_advise: 20000, sip_invested: 0 });

      // Moving more than is left to advise is refused.
      await expect(ctx.as("advisor", (t) => convertBuyToSip(t, ctx.users.advisor, p.buyItem, { monthlyAmount: 1, lumpsumAmount: 999999, reason: "x" })))
        .rejects.toThrow(/not yet advised/);

      await ctx.as("advisor", (t) => setSipStatus(t, sipItemId, "ADVISED", "told on call"));
      await ctx.tx`update public.sip_plan_items set advised_at = '2026-09-02T10:00:00+05:30' where id = ${sipItemId}`;
      // CAS: one instalment before the advice (not counted), two after.
      await ctx.as("ops", async (t) => {
        const pr = parsed("2026-10-01", [{ security: ctx.sec.Y, name: y.scheme_name, units: 400, nav: 100 }], [
          { date: "2026-08-05", type: "SIP", scheme_name: y.scheme_name, isin: y.isin, folio_number: "T1", amount: 20000, units: 200, nav: 100, balance_units: 200 },
          { date: "2026-09-05", type: "SIP", scheme_name: y.scheme_name, isin: y.isin, folio_number: "T1", amount: 20000, units: 100, nav: 200, balance_units: 300 },
          { date: "2026-10-01", type: "SIP", scheme_name: y.scheme_name, isin: y.isin, folio_number: "T1", amount: 20000, units: 100, nav: 200, balance_units: 400 },
        ]);
        pr.holdings[0].isin = y.isin;
        const id = await createSnapshotFromParsed(t, { clientId: p.clientId, casDocumentId: null, parsed: pr, source: "CAS", createdBy: ctx.users.ops.id });
        await confirmSnapshot(t, id, "checked");
      });
      const rows = await ctx.as("advisor", (t) => getSipProgress(t, p.planId));
      expect(rows.find((r) => r.sip_item_id === sipItemId)).toMatchObject({ monthly_amount: 20000, invested_amount: 40000, instalments: 2 });
      sip = await ctx.as("advisor", (t) => getClientSip(t, p.clientId));
      expect(sip).toMatchObject({ sip_monthly_advised: 20000, sip_invested: 40000, lumpsum_buy_executed: 0, total_invested_under_plan: 40000 });

      // The advisor corrects the monthly amount, then it goes back to a lump sum.
      await ctx.as("advisor", (t) => updateSipAmounts(t, sipItemId, { oldAmount: null, newAmount: 25000, debitDay: 5 }, "client raised it"));
      expect((await ctx.as("advisor", (t) => getClientSip(t, p.clientId))).sip_monthly_target).toBe(25000);
      const { planItemId } = await ctx.as("advisor", (t) => convertSipToLumpsum(t, ctx.users.advisor, sipItemId, { lumpsumAmount: 200000, reason: "lump sum after all" }));
      expect((await progress(ctx, planItemId)).target_amount).toBe(200000);
      sip = await ctx.as("advisor", (t) => getClientSip(t, p.clientId));
      expect(sip.sip_monthly_target).toBe(0);
    });
  });

  it("an instalment counts once even when two SIP lines are on the same fund", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx);
      const y = (await ctx.tx<{ scheme_name: string; isin: string }[]>`select scheme_name, isin from public.security_master where id = ${ctx.sec.Y}`)[0];
      await ctx.as("advisor", (t) => convertBuyToSip(t, ctx.users.advisor, p.buyItem, { monthlyAmount: 10000, lumpsumAmount: 100000, reason: "part 1" }));
      await ctx.as("advisor", (t) => convertBuyToSip(t, ctx.users.advisor, p.buyItem, { monthlyAmount: 10000, lumpsumAmount: 100000, reason: "part 2" }));
      await ctx.as("ops", async (t) => {
        const pr = parsed("2026-10-01", [{ security: ctx.sec.Y, name: y.scheme_name, units: 200, nav: 100 }], [
          { date: "2026-09-30", type: "SIP", scheme_name: y.scheme_name, isin: y.isin, folio_number: "T1", amount: 20000, units: 200, nav: 100, balance_units: 200 },
        ]);
        pr.holdings[0].isin = y.isin;
        const id = await createSnapshotFromParsed(t, { clientId: p.clientId, casDocumentId: null, parsed: pr, source: "CAS", createdBy: ctx.users.ops.id });
        await confirmSnapshot(t, id, "checked");
      });
      // Plan approved in the harness before 30-Sep, so the instalment is after both lines start.
      await ctx.tx`update public.sip_plan_items set advised_at = '2026-09-01T10:00:00+05:30' where plan_id = ${p.planId}`;
      const sip = await ctx.as("advisor", (t) => getClientSip(t, p.clientId));
      expect(sip.sip_invested).toBe(20000);
      expect(sip.sip_monthly_target).toBe(20000);
    });
  });
});
