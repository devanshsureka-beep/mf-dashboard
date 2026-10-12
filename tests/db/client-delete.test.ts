import { afterAll, describe, expect, it } from "vitest";
import { deleteClients, listDeletedClients, restoreClients } from "@/services/client-admin";
import { listDeskClients } from "@/services/clients";
import { clientWithActivePlan, scenario, sql, TEST_DB } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});

describeDb("Deleting clients (admin)", () => {
  it("hides the client and everything under it, keeps history, frees the PAN, and can be restored", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx);
      const q = await clientWithActivePlan(ctx);
      await ctx.tx`update public.clients set pan = 'ABCDE1234F' where id = ${p.clientId}`;
      const visible = async (who: "advisor" | "ops" | "admin") =>
        (await ctx.as(who, (t) => listDeskClients(t, {}))).map((c) => c.client_id).filter((id) => id === p.clientId || id === q.clientId).length;
      expect(await visible("advisor")).toBe(2);

      await expect(ctx.as("advisor", (t) => deleteClients(t, ctx.users.advisor, [p.clientId], "x"))).rejects.toThrow(/Only an admin/);
      await expect(ctx.as("admin", (t) => deleteClients(t, ctx.users.admin, [p.clientId], " "))).rejects.toThrow(/reason/);
      // The database refuses a delete without the admin path too.
      expect(await ctx.expectError("advisor", (t) => t`update public.clients set deleted_at = now() where id = ${p.clientId}`)).toMatch(/admin|reason|0 rows|permission/i);

      expect(await ctx.as("admin", (t) => deleteClients(t, ctx.users.admin, [p.clientId, q.clientId], "duplicate onboarding"))).toBe(2);
      for (const who of ["advisor", "ops", "admin"] as const) expect(await visible(who)).toBe(0);
      // Everything under the client is hidden, but nothing is erased.
      expect((await ctx.as("advisor", (t) => t`select id from public.advisory_plans where client_id = ${p.clientId}`)).length).toBe(0);
      expect((await ctx.as("admin", (t) => t`select id from public.portfolio_snapshots where client_id = ${p.clientId}`)).length).toBe(0);
      expect((await ctx.tx`select id from public.advisory_plans where client_id = ${p.clientId}`).length).toBe(1);
      // The PAN is free again.
      await ctx.tx`insert into public.clients (full_name, pan) values ('Re-onboarded', 'ABCDE1234F')`;

      const deleted = await ctx.as("admin", (t) => listDeletedClients(t));
      expect(deleted.find((d) => d.id === p.clientId)).toMatchObject({ deleted_reason: "duplicate onboarding" });
      expect(await ctx.as("advisor", (t) => listDeletedClients(t))).toHaveLength(0);

      // Restoring p clashes with the re-onboarded PAN; q restores fine.
      await expect(ctx.as("admin", (t) => restoreClients(t, ctx.users.admin, [p.clientId], "mistake"))).rejects.toThrow(/already has this PAN/);
      expect(await ctx.as("admin", (t) => restoreClients(t, ctx.users.admin, [q.clientId], "mistake"))).toBe(1);
      expect(await visible("advisor")).toBe(1);
      const audit = await ctx.tx<{ reason: string }[]>`select reason from public.audit_logs where entity_id = ${q.clientId} and reason like 'Client %'`;
      expect(audit.map((a) => a.reason)).toEqual(expect.arrayContaining(["Client deleted: duplicate onboarding", "Client restored: mistake"]));
    });
  });
});
