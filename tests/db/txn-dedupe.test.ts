import { afterAll, describe, expect, it } from "vitest";
import { createClient } from "@/services/clients";
import { createSnapshotFromParsed } from "@/services/portfolio";
import { parsed, scenario, sql, TEST_DB } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});

describeDb("CAS transactions stored once", () => {
  it("the same trade in two overlapping CAS files, under two type labels, is one transaction linked to both", async () => {
    await scenario(async (ctx) => {
      const client = await ctx.as("advisor", (t) => createClient(t, ctx.users.advisor, { full_name: "Dedupe Client", status: "ACTIVE" }));
      const [x] = await ctx.tx<{ isin: string; scheme_name: string }[]>`select isin, scheme_name from public.security_master where id = ${ctx.sec.X}`;
      const txn = (type: "PURCHASE" | "SIP") => ({
        date: "2026-04-24", type, scheme_name: x.scheme_name, isin: x.isin, folio_number: "T1",
        units: 213.396, nav: 46.859, amount: 9999.5, balance_units: 448.978, description: "Net Systematic Purchase - Instalment",
      });
      const snap = (date: string, type: "PURCHASE" | "SIP") => ctx.as("advisor", (t) => createSnapshotFromParsed(t, {
        clientId: client.id, casDocumentId: null, source: "SEED", createdBy: ctx.users.advisor.id,
        parsed: parsed(date, [{ security: ctx.sec.X, name: x.scheme_name, units: 448.978, nav: 47 }], [txn(type)]),
      }));
      const s1 = await snap("2026-09-18", "PURCHASE");
      const s2 = await snap("2026-10-15", "SIP");
      const rows = await ctx.tx<{ id: string }[]>`select id from public.portfolio_transactions where client_id = ${client.id} and units is not null`;
      expect(rows).toHaveLength(1);
      const links = await ctx.tx<{ snapshot_id: string }[]>`select snapshot_id from public.portfolio_snapshot_transactions where transaction_id = ${rows[0].id} order by snapshot_id`;
      expect(links.map((l) => l.snapshot_id).sort()).toEqual([s1, s2].sort());
      // A genuinely different trade the same day (another balance after it) is kept.
      await ctx.as("advisor", (t) => createSnapshotFromParsed(t, {
        clientId: client.id, casDocumentId: null, source: "SEED", createdBy: ctx.users.advisor.id,
        parsed: parsed("2026-10-20", [{ security: ctx.sec.X, name: x.scheme_name, units: 662.374, nav: 47 }], [txn("SIP"), { ...txn("SIP"), balance_units: 662.374 }]),
      }));
      expect((await ctx.tx`select 1 from public.portfolio_transactions where client_id = ${client.id} and units is not null`).length).toBe(2);
    });
  });
});
