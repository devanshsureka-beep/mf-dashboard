import { afterAll, describe, expect, it } from "vitest";
import { findProfileByEmail, removeTeamMember, restoreTeamMember } from "@/services/team";
import { clientWithActivePlan, scenario, sql, TEST_DB } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});

describeDb("Removing and adding back team members", () => {
  it("refuses yourself, a non-admin, and a main advisor who still has clients; keeps history; adds back", async () => {
    await scenario(async (ctx) => {
      const { admin, advisor, ops } = ctx.users;
      expect(await ctx.expectError("admin", (t) => removeTeamMember(t, admin, admin.id, "x"))).toMatch(/cannot remove yourself/);
      expect(await ctx.expectError("advisor", (t) => removeTeamMember(t, advisor, ops.id, "x"))).toMatch(/Only an admin/);
      expect(await ctx.expectError("admin", (t) => removeTeamMember(t, admin, ops.id, " "))).toMatch(/reason/);

      // The advisor is the main advisor of a client: move the client first.
      await clientWithActivePlan(ctx);
      expect(await ctx.expectError("admin", (t) => removeTeamMember(t, admin, advisor.id, "left"))).toMatch(/main advisor of 1 client/);

      // Operations has no clients of their own: removed; profile stays, inactive, assignments ended.
      await ctx.as("admin", (t) => removeTeamMember(t, admin, ops.id, "Left the company"));
      const [p] = await ctx.tx<{ is_active: boolean; removed_at: Date | null; removed_by: string }[]>`select is_active, removed_at, removed_by from public.profiles where id = ${ops.id}`;
      expect(p).toMatchObject({ is_active: false, removed_by: admin.id });
      expect(p.removed_at).not.toBeNull();
      expect(await ctx.expectError("admin", (t) => removeTeamMember(t, admin, ops.id, "again"))).toMatch(/already removed/);
      // A removed member cannot be switched back on by the database either (removed ⇒ inactive).
      expect(await ctx.expectError("admin", (t) => t`update public.profiles set is_active = true where id = ${ops.id}`)).toMatch(/profiles_removed_inactive/);

      // Adding back (by email, as the Add user form does).
      const found = await ctx.as("admin", (t) => findProfileByEmail(t, ops.email.toUpperCase()));
      expect(found).toEqual({ id: ops.id, removed: true, active: false });
      await ctx.as("admin", (t) => restoreTeamMember(t, admin, ops.id, { role: "ADVISOR", fullName: "Back Again" }));
      const [q] = await ctx.tx<{ is_active: boolean; removed_at: Date | null; role: string; full_name: string }[]>`select is_active, removed_at, role, full_name from public.profiles where id = ${ops.id}`;
      expect(q).toEqual({ is_active: true, removed_at: null, role: "ADVISOR", full_name: "Back Again" });
    });
  });
});
