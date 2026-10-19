import { afterAll, describe, expect, it } from "vitest";
import { confirmSnapshot, createSnapshotFromParsed } from "@/services/portfolio";
import { clientWithActivePlan, parsed, scenario, sql, TEST_DB } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});

describeDb("v_sip_instalments: one rule for SIP instalments", () => {
  it("counts a monthly run of plain purchases, and not an instalment that bounced", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx);
      const y = (await ctx.tx<{ scheme_name: string; isin: string }[]>`select scheme_name, isin from public.security_master where id = ${ctx.sec.Y}`)[0];
      const buy = (date: string, units: number) => ({ date, type: "PURCHASE" as const, description: "Purchase", scheme_name: y.scheme_name, isin: y.isin, folio_number: "T1", amount: 5000, units, nav: 100, balance_units: 0 });
      await ctx.as("ops", async (t) => {
        const pr = parsed("2026-10-10", [{ security: ctx.sec.Y, name: y.scheme_name, units: 150, nav: 100 }], [
          // A broker SIP the CAS calls "Purchase": four months of ₹5,000.
          buy("2026-06-05", 50), buy("2026-07-06", 50), buy("2026-08-05", 50), buy("2026-09-05", 50),
          // September's instalment bounced.
          { date: "2026-09-08", type: "OTHER", description: "Systematic Investment Rejection", scheme_name: y.scheme_name, isin: y.isin, folio_number: "T1", amount: -5000, units: -50, nav: 100, balance_units: 150 },
          // A one-off purchase of another amount is not an instalment.
          { date: "2026-09-20", type: "PURCHASE", description: "Purchase", scheme_name: y.scheme_name, isin: y.isin, folio_number: "T1", amount: 20000, units: 200, nav: 100, balance_units: 350 },
        ]);
        pr.holdings[0].isin = y.isin;
        const id = await createSnapshotFromParsed(t, { clientId: p.clientId, casDocumentId: null, parsed: pr, source: "CAS", createdBy: ctx.users.ops.id });
        await confirmSnapshot(t, id, "checked");
      });
      const rows = await ctx.tx<{ d: string; amount: number }[]>`
        select transaction_date::text as d, amount::float8 as amount from public.v_sip_instalments where client_id = ${p.clientId} order by 1`;
      expect(rows.map((r) => r.d)).toEqual(["2026-06-05", "2026-07-06", "2026-08-05"]);
      expect(rows.every((r) => r.amount === 5000)).toBe(true);
    });
  });

  it("two SIPs bounced on the same day take back two instalments", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx);
      const y = (await ctx.tx<{ scheme_name: string; isin: string }[]>`select scheme_name, isin from public.security_master where id = ${ctx.sec.Y}`)[0];
      const line = (date: string, units: number, balance: number, description: string) =>
        ({ date, type: (units > 0 ? "SIP" : "OTHER") as "SIP" | "OTHER", description, scheme_name: y.scheme_name, isin: y.isin, folio_number: "T1", amount: units * 100, units, nav: 100, balance_units: balance });
      await ctx.as("ops", async (t) => {
        const pr = parsed("2026-10-10", [{ security: ctx.sec.Y, name: y.scheme_name, units: 100, nav: 100 }], [
          // Two ₹5,000 SIPs in the same folio, both on the 5th; both bounced on the 8th.
          line("2026-09-05", 50, 50, "Systematic Investment"), line("2026-09-05", 50, 100, "Systematic Investment (2)"),
          line("2026-09-08", -50, 50, "Systematic Investment Rejection"), line("2026-09-08", -50, 0, "Systematic Investment Rejection (2)"),
          line("2026-10-05", 50, 50, "Systematic Investment"),
        ]);
        pr.holdings[0].isin = y.isin;
        const id = await createSnapshotFromParsed(t, { clientId: p.clientId, casDocumentId: null, parsed: pr, source: "CAS", createdBy: ctx.users.ops.id });
        await confirmSnapshot(t, id, "checked");
      });
      const rows = await ctx.tx<{ d: string }[]>`select transaction_date::text as d from public.v_sip_instalments where client_id = ${p.clientId} order by 1`;
      expect(rows.map((r) => r.d)).toEqual(["2026-10-05"]);
    });
  });
});
