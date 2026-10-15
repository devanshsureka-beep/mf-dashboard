import { afterAll, describe, expect, it } from "vitest";
import { fundsHeldMatching, holdingsOfFund } from "@/services/bulk-advice";
import { clientWithActivePlan, scenario, sql, TEST_DB } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});

describeDb("Calling clients by a fund they hold", () => {
  it("finds the fund by any words of its name or its ISIN, and each holder's value in it", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx); // latest CAS: X 10,000 units @ ₹150
      const x = (await ctx.tx<{ scheme_name: string; isin: string }[]>`select scheme_name, isin from public.security_master where id = ${ctx.sec.X}`)[0];
      const words = x.scheme_name.split(/\s+/).filter((w) => w.length > 2);
      const byName = await ctx.as("admin", (t) => fundsHeldMatching(t, `${words[0].toLowerCase()} ${words.at(-1)!.toUpperCase()}`));
      const hit = byName.find((f) => f.security_id === ctx.sec.X);
      expect(hit).toMatchObject({ clients: expect.any(Number) });
      expect(hit!.total).toBeGreaterThanOrEqual(1500000);
      expect((await ctx.as("admin", (t) => fundsHeldMatching(t, x.isin))).map((f) => f.security_id)).toEqual([ctx.sec.X]);
      expect(await ctx.as("admin", (t) => fundsHeldMatching(t, "no such fund zzz"))).toEqual([]);

      const holders = await ctx.as("admin", (t) => holdingsOfFund(t, ctx.sec.X));
      expect(holders.get(p.clientId)).toEqual({ value: 1500000, units: 10000, folios: 1 });
      // Another advisor's view stays limited to their own clients.
      const other = await ctx.as("otherAdvisor", (t) => holdingsOfFund(t, ctx.sec.X));
      expect(other.has(p.clientId)).toBe(false);
    });
  });
});
