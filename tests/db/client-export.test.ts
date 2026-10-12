import { afterAll, describe, expect, it } from "vitest";
import { exportReadme, gatherClientExport } from "@/services/client-export";
import { toCsv } from "@/lib/zip";
import { clientWithActivePlan, scenario, sql, TEST_DB } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});

describeDb("Client export (ZIP contents)", () => {
  it("collects every record type for the client, under RLS", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx);
      const e = await ctx.as("advisor", (t) => gatherClientExport(t, p.clientId));
      expect(e.client.id).toBe(p.clientId);
      const byFile = Object.fromEntries(e.tables.map((t) => [t.file, t]));
      expect(byFile["01 client.csv"].rows).toHaveLength(1);
      expect(byFile["10 plans.csv"].rows.length).toBeGreaterThan(0);
      expect(byFile["11 plan lines (progress).csv"].columns).toContain("client_id");
      expect(byFile["00 timeline.csv"].rows.length).toBeGreaterThan(0);
      // Every table renders as CSV and every row belongs to this client.
      for (const t of e.tables) {
        expect(toCsv(t.columns, t.rows)).toContain(t.columns[0] ?? "");
        for (const r of t.rows) if ("client_id" in r) expect(r.client_id).toBe(p.clientId);
      }
      expect(exportReadme(e, "Tester", [])).toContain(e.client.client_code);

      // A deleted client cannot be exported by anyone.
      await ctx.tx`select set_config('app.audit_reason', 'test', true)`;
      await ctx.tx`update public.clients set deleted_at = now() where id = ${p.clientId}`;
      await expect(ctx.as("admin", (t) => gatherClientExport(t, p.clientId))).rejects.toThrow(/not found/i);
    });
  });
});
