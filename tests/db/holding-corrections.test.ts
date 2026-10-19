import { afterAll, describe, expect, it } from "vitest";
import { confirmSnapshot, createSnapshotFromParsed } from "@/services/portfolio";
import { runReconciliation } from "@/services/reconciliation";
import { getEditableHoldings, saveHoldingCorrection } from "@/services/holding-corrections";
import { clientWithActivePlan, parsed, scenario, sql, TEST_DB } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});

describeDb("Edit holdings", () => {
  it("saves a correction as the latest holdings; the CAS stays and the next CAS still matches against it", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx); // CAS of 01-Sep: X 10,000 units @150
      const y = (await ctx.tx<{ isin: string; scheme_name: string }[]>`select isin, scheme_name from public.security_master where id = ${ctx.sec.Y}`)[0];
      await ctx.tx`insert into public.mf_schemes (isin, amfi_code, scheme_name, nav, nav_date) values (${y.isin}, '999001', ${y.scheme_name}, 50, '2026-09-14')`;

      const ed = (await ctx.as("advisor", (t) => getEditableHoldings(t, p.clientId)))!;
      expect(ed.snapshotId).toBe(p.snapshotId);
      expect(ed.rows.map((r) => [r.security_id, r.units])).toEqual([[ctx.sec.X, 10000]]);
      const x = ed.rows[0];
      const input = {
        clientId: p.clientId, baseSnapshotId: p.snapshotId, asOf: "2026-09-15", reason: "Client statement: bought more X, holds Y elsewhere",
        rows: [
          { holdingId: x.holding_id, fundRef: null, folio: x.folio_number, units: 12000 },
          { holdingId: null, fundRef: `sec:${ctx.sec.Y}`, folio: "F-1", units: 100 },
        ],
      };

      expect(await ctx.expectError("ops", (t) => saveHoldingCorrection(t, ctx.users.ops, input))).toMatch(/advisor or admin/);
      expect(await ctx.expectError("advisor", (t) => saveHoldingCorrection(t, ctx.users.advisor, { ...input, reason: " " }))).toMatch(/reason/);
      expect(await ctx.expectError("advisor", (t) => saveHoldingCorrection(t, ctx.users.advisor, { ...input, asOf: "2026-08-01" }))).toMatch(/before the current holdings/);
      expect(await ctx.expectError("advisor", (t) => saveHoldingCorrection(t, ctx.users.advisor, { ...input, rows: input.rows.slice(0, 1).map((r) => ({ ...r, units: 10000 })) }))).toMatch(/Nothing changed/);
      expect(await ctx.expectError("advisor", (t) => saveHoldingCorrection(t, ctx.users.advisor, { ...input, rows: [...input.rows, input.rows[1]] }))).toMatch(/listed twice/);

      const { snapshotId, changes } = await ctx.as("advisor", (t) => saveHoldingCorrection(t, ctx.users.advisor, input));
      expect(changes.map((c) => c.kind)).toEqual(["EDITED", "ADDED"]);
      const snap = (await ctx.tx<{ is_correction: boolean; source: string; review_status: string; review_note: string; snapshot_date: string; total_current_value: number; correction_of: string }[]>`
        select is_correction, source, review_status, review_note, snapshot_date::text, total_current_value::float8, correction_of from public.portfolio_snapshots where id = ${snapshotId}`)[0];
      expect(snap).toEqual({ is_correction: true, source: "MANUAL", review_status: "CONFIRMED", review_note: input.reason, snapshot_date: "2026-09-15", total_current_value: 12000 * 150 + 100 * 50, correction_of: p.snapshotId });
      const live = await ctx.as("advisor", (t) => t<{ security_id: string; units: number; folio_number: string | null }[]>`
        select security_id, units::float8, folio_number from public.v_holding_live where client_id = ${p.clientId} order by units desc`);
      expect(live).toEqual([{ security_id: ctx.sec.X, units: 12000, folio_number: x.folio_number }, { security_id: ctx.sec.Y, units: 100, folio_number: "F-1" }]);
      // The CAS it started from is untouched.
      expect((await ctx.tx<{ n: number }[]>`select count(*)::int as n from public.portfolio_holdings where snapshot_id = ${p.snapshotId}`)[0].n).toBe(1);
      // What it is never changes; it was audited with its reason.
      expect(await ctx.expectError("admin", (t) => t`update public.portfolio_snapshots set is_correction = false where id = ${snapshotId}`)).toMatch(/cannot|immutable|changed/i);
      const audit = await ctx.tx<{ reason: string }[]>`select reason from public.audit_logs where entity_id = ${snapshotId} order by occurred_at limit 1`;
      expect(audit[0]?.reason).toMatch(/Holdings corrected/);

      // Editing again from the old holdings is refused; a correction is not matched against calls.
      expect(await ctx.expectError("advisor", (t) => saveHoldingCorrection(t, ctx.users.advisor, input))).toMatch(/changed since you opened/);
      expect(await ctx.expectError("ops", (t) => runReconciliation(t, ctx.users.ops, { clientId: p.clientId, currentSnapshotId: snapshotId }))).toMatch(/not a CAS/);

      // The next CAS replaces it and is compared with the previous CAS, not the correction.
      const next = await ctx.as("advisor", async (t) => {
        const id = await createSnapshotFromParsed(t, { clientId: p.clientId, casDocumentId: null, parsed: parsed("2026-10-01", [{ security: ctx.sec.X, name: "X", units: 11000, nav: 155 }]), source: "SEED", createdBy: ctx.users.advisor.id });
        return { id, ...(await confirmSnapshot(t, id, "next CAS")) };
      });
      expect(next.previousSnapshotId).toBe(p.snapshotId);
      expect((await ctx.as("advisor", (t) => getEditableHoldings(t, p.clientId)))!.snapshotId).toBe(next.id);
    });
  });

  it("a CAS confirmed after a correction replaces it, even with an earlier statement date", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx); // CAS of 01-Sep: X 10,000 units @150
      // A CAS of 10-Sep is uploaded and waits for a check.
      const xi = (await ctx.tx<{ isin: string; scheme_name: string }[]>`select isin, scheme_name from public.security_master where id = ${ctx.sec.X}`)[0];
      await ctx.tx`insert into public.mf_schemes (isin, amfi_code, scheme_name, nav, nav_date) values (${xi.isin}, '999003', ${xi.scheme_name}, 150, '2026-09-01')`;
      const pending = await ctx.as("advisor", (t) => createSnapshotFromParsed(t, { clientId: p.clientId, casDocumentId: null, parsed: parsed("2026-09-10", [{ security: ctx.sec.X, name: "X", units: 9000, nav: 150 }]), source: "SEED", createdBy: ctx.users.advisor.id }));
      const ed = (await ctx.as("advisor", (t) => getEditableHoldings(t, p.clientId)))!;
      expect(ed.pendingCasDate).toBe("2026-09-10");
      const x = ed.rows[0];
      // Corrected on 20-Sep: the same fund cannot be added again on its folio.
      const base = { clientId: p.clientId, baseSnapshotId: p.snapshotId, asOf: "2026-09-20", reason: "Client statement" };
      expect(await ctx.expectError("advisor", (t) => saveHoldingCorrection(t, ctx.users.advisor, { ...base, rows: [
        { holdingId: x.holding_id, fundRef: null, folio: x.folio_number, units: 10000 },
        { holdingId: null, fundRef: `sec:${ctx.sec.X}`, folio: x.folio_number, units: 5 },
      ] }))).toMatch(/listed twice/);
      const { snapshotId } = await ctx.as("advisor", (t) => saveHoldingCorrection(t, ctx.users.advisor, { ...base, rows: [{ holdingId: x.holding_id, fundRef: null, folio: x.folio_number, units: 12000 }] }));
      const latest = async () => (await ctx.as("advisor", (t) => t<{ snapshot_id: string }[]>`select snapshot_id from public.v_latest_snapshot where client_id = ${p.clientId}`))[0].snapshot_id;
      expect(await latest()).toBe(snapshotId);
      // The 10-Sep CAS is confirmed after the correction: it is now the holdings.
      await ctx.as("advisor", (t) => confirmSnapshot(t, pending, "checked"));
      expect(await latest()).toBe(pending);
    });
  });

  it("keeps the known cost of unchanged lines", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx);
      const y = (await ctx.tx<{ isin: string; scheme_name: string }[]>`select isin, scheme_name from public.security_master where id = ${ctx.sec.Y}`)[0];
      await ctx.tx`insert into public.mf_schemes (isin, amfi_code, scheme_name, nav, nav_date) values (${y.isin}, '999002', ${y.scheme_name}, 50, '2026-09-14')`;
      // Give the CAS line a cost (the harness CAS has none).
      const snap = await ctx.as("advisor", async (t) => {
        const pp = parsed("2026-09-05", [{ security: ctx.sec.X, name: "X", units: 10000, nav: 150 }]);
        pp.holdings[0].cost_value = 1200000;
        const id = await createSnapshotFromParsed(t, { clientId: p.clientId, casDocumentId: null, parsed: pp, source: "SEED", createdBy: ctx.users.advisor.id });
        await confirmSnapshot(t, id, "with cost");
        return id;
      });
      const x = (await ctx.as("advisor", (t) => getEditableHoldings(t, p.clientId)))!.rows[0];
      const { snapshotId } = await ctx.as("advisor", (t) => saveHoldingCorrection(t, ctx.users.advisor, {
        clientId: p.clientId, baseSnapshotId: snap, asOf: "2026-09-06", reason: "Holds Y elsewhere",
        rows: [{ holdingId: x.holding_id, fundRef: null, folio: x.folio_number, units: 10000 }, { holdingId: null, fundRef: `sec:${ctx.sec.Y}`, folio: null, units: 10 }],
      }));
      const s = (await ctx.tx<{ v: number }[]>`select total_invested_value::float8 as v from public.portfolio_snapshots where id = ${snapshotId}`)[0];
      expect(s.v).toBe(1200000);
    });
  });

  it("is not offered before the first CAS", async () => {
    await scenario(async (ctx) => {
      const c = (await ctx.tx<{ id: string }[]>`insert into public.clients (full_name, client_code, status) values ('No CAS', ${`T-${Date.now()}`}, 'ACTIVE') returning id`)[0];
      expect(await ctx.asSuper((t) => getEditableHoldings(t, c.id))).toBeNull();
    });
  });
});
