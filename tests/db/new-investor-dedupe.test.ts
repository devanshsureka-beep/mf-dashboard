import { afterAll, describe, expect, it } from "vitest";
import type { AdvisoryReportParse } from "@/lib/parsers/advisory-report";
import { createNewInvestor } from "@/services/onboarding";
import { scenario, sql, TEST_DB } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});
const report = (): AdvisoryReportParse => ({
  template: "GENERIC_TABLES", clientName: "Kavya Demo", riskProfile: "MODERATE", goal: "x",
  casPeriod: { from: null, to: null }, valuationDate: null, preparedDate: "2026-10-10", currentValue: null,
  sells: [], sellTotal: null,
  buys: [{ fund: "Sample Large Cap Fund - Direct Plan - Growth", amc: "Sample AMC", category: "Large Cap", planType: "DIRECT", amount: 300000, mode: null, fundedBy: null, kind: "NEW" }],
  buyTotal: 300000, sips: [], sipTotals: { current: null, next: null }, sipRouting: [], review: [], holds: [], mentioned: [], deploymentNotes: [], problems: [], warnings: [],
} as unknown as AdvisoryReportParse);

describeDb("New investor without a PAN", () => {
  it("is not created twice when another advisor already has the same name and mobile", async () => {
    await scenario(async (ctx) => {
      const phone = `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
      await ctx.as("advisor", (t) => createNewInvestor(t, ctx.users.advisor, { who: { phone }, report: report() }));
      expect(await ctx.expectError("otherAdvisor", (t) => createNewInvestor(t, ctx.users.otherAdvisor, { who: { phone }, report: report() })))
        .toMatch(/already a client of another advisor/);
      const n = await ctx.tx<{ n: number }[]>`select count(*)::int as n from public.clients where right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) = ${phone}`;
      expect(n[0].n).toBe(1);
    });
  });
});
