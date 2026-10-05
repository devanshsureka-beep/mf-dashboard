import { afterAll, describe, expect, it } from "vitest";
import { advisoryReportResultSchema } from "@/lib/integrations/contracts";
import { recordExecution } from "@/services/executions";
import { convertMigrateNotes, countMigrateNotes, getMigrations, issueMigrationCalls } from "@/services/migrations";
import { addPlanItem, approvePlan, ingestAdvisoryReport } from "@/services/plans";
import { ingestNavFeed } from "@/services/nav";
import { resolveFundRef } from "@/services/fund-search";
import { confirmSnapshot, createSnapshotFromParsed } from "@/services/portfolio";
import { runReconciliation } from "@/services/reconciliation";
import { clientWithActivePlan, parsed, scenario, sql, TEST_DB } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});

describeDb("Migrate to Direct checklist", () => {
  it("is a plan line outside the sell/buy targets, executed through a switch call", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx); // holds X (10,000 units)
      const names = await ctx.tx<{ id: string; scheme_name: string }[]>`select id, scheme_name from public.security_master where id in (${ctx.sec.X}, ${ctx.sec.Y})`;
      const nameOf = (id: string) => names.find((n) => n.id === id)!.scheme_name;
      const payload = advisoryReportResultSchema.parse({
        client_id: p.clientId, status: "PARSED",
        plan: { plan_name: "Rebalancing with migration" },
        items: [
          { action: "MIGRATE", scheme_name: nameOf(ctx.sec.X), target_amount: 1500000, current_amount: 1500000, switch_to_scheme_name: nameOf(ctx.sec.Y), reason: "MIGRATE TO DIRECT; Hold" },
          { action: "BUY", scheme_name: nameOf(ctx.sec.Y), target_amount: 100000 },
        ],
      });
      const ids = { [nameOf(ctx.sec.X).toLowerCase()]: ctx.sec.X, [nameOf(ctx.sec.Y).toLowerCase()]: ctx.sec.Y };
      const draft = await ctx.as("advisor", (t) => ingestAdvisoryReport(t, payload, ctx.users.advisor.id, { extractionSource: "IMPORT", securityIds: ids }));
      await ctx.as("advisor", (t) => approvePlan(t, ctx.users.advisor, draft.planId!, "replace with migration plan"));
      const planId = draft.planId!;

      // Not in the lump-sum targets.
      const t = (await ctx.tx<{ sell_target: number; buy_target: number }[]>`
        select sell_target::float8, buy_target::float8 from public.v_plan_transition where plan_id = ${planId}`)[0];
      expect(t).toEqual({ sell_target: 0, buy_target: 100000 });

      let m = await ctx.as("advisor", (tx) => getMigrations(tx, planId));
      expect(m).toHaveLength(1);
      expect(m[0]).toMatchObject({ migration_status: "TO_DO", switch_to_security_id: ctx.sec.Y, regular_units_now: 10000 });

      const r = await ctx.as("advisor", (tx) => issueMigrationCalls(tx, ctx.users.advisor, {
        clientId: p.clientId, planId, planItemIds: [m[0].plan_item_id], channel: "PHONE", communicatedAt: new Date("2026-09-30T11:00:00+05:30"),
      }));
      expect(r.count).toBe(1);
      const call = (await ctx.tx<{ id: string; action: string; quantity_basis: string; advised_units: number }[]>`
        select id, action, quantity_basis, advised_units::float8 from public.advice_items where plan_item_id = ${m[0].plan_item_id}`)[0];
      expect(call).toMatchObject({ action: "SWITCH", quantity_basis: "UNITS", advised_units: 10000 });
      m = await ctx.as("advisor", (tx) => getMigrations(tx, planId));
      expect(m[0].migration_status).toBe("CALL_ISSUED");
      // Issuing again does nothing for a line that already has a call.
      await expect(ctx.as("advisor", (tx) => issueMigrationCalls(tx, ctx.users.advisor, {
        clientId: p.clientId, planId, planItemIds: [m[0].plan_item_id], channel: "PHONE", communicatedAt: new Date("2026-09-30T11:00:00+05:30"),
      }))).rejects.toThrow(/already have a call/);

      await ctx.as("ops", (tx) => recordExecution(tx, ctx.users.ops, { adviceItemId: call.id, executionDate: "2026-09-30", executedAmount: 1510000, executedUnits: 10000, verificationType: "CLIENT_CONFIRMED" }));
      m = await ctx.as("advisor", (tx) => getMigrations(tx, planId));
      expect(m[0].migration_status).toBe("DONE");
      // A switch moves money fund to fund: money left is unchanged.
      const cash = await ctx.tx<{ money_left: number }[]>`select money_left::float8 from public.v_client_summary where client_id = ${p.clientId}`;
      expect(cash[0].money_left).toBe(0);
    });
  });

  it("turns Migrate to Direct notes of an approved plan into checklist lines, pointing at the AMFI Direct plan", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx);
      const tag = String(Math.floor(Math.random() * 1e6)).padStart(6, "0");
      const reg = `INFZR${tag}1`;
      const dir = `INFZD${tag}2`;
      const base = { amfi_code: "1", amc: `Zeta ${tag} Mutual Fund`, category: "Equity Scheme - Flexi Cap Fund", option_type: "GROWTH" as const, nav: 50, nav_date: "2026-09-30" };
      await ctx.asSuper((t) => ingestNavFeed(t, { navDate: "2026-09-30", schemes: [
        { ...base, isin: reg, scheme_name: `Zeta ${tag} Flexi Cap Fund - Regular Plan - Growth`, plan_type: "REGULAR" },
        { ...base, isin: dir, scheme_name: `Zeta ${tag} Flexi Cap Fund - Direct Plan - Growth`, plan_type: "DIRECT" },
        { ...base, isin: `INFZD${tag}3`, scheme_name: `Zeta ${tag} Small Cap Fund - Direct Plan - Growth`, plan_type: "DIRECT", category: "Equity Scheme - Small Cap Fund" },
      ] }, "test"));
      const regSec = await ctx.as("advisor", (t) => resolveFundRef(t, `isin:${reg}`, ctx.users.advisor.id));
      await ctx.as("advisor", (t) => addPlanItem(t, ctx.users.advisor, p.planId, {
        security_id: regSec, scheme_name: `Zeta ${tag} Flexi Cap Fund - Regular Plan - Growth`, action: "RETAIN", target_amount: 0,
        current_amount: 300000, reason: "Kept for now: Migrate to Direct; Hold",
      }, "test: old-style plan line"));
      expect(await ctx.as("advisor", (t) => countMigrateNotes(t, p.planId))).toBe(1);

      expect(await ctx.as("advisor", (t) => convertMigrateNotes(t, ctx.users.advisor, p.planId))).toBe(1);
      const m = await ctx.as("advisor", (t) => getMigrations(t, p.planId));
      expect(m).toHaveLength(1);
      const dirSec = (await ctx.tx<{ id: string }[]>`select id from public.security_master where isin = ${dir}`)[0].id;
      expect(m[0]).toMatchObject({ switch_to_security_id: dirSec, current_value: 300000, reason: "Migrate to Direct; Hold", migration_status: "TO_DO" });
      expect(await ctx.as("advisor", (t) => countMigrateNotes(t, p.planId))).toBe(0);
      // Audited with a reason; the lump-sum targets are unchanged.
      const t = (await ctx.tx<{ sell_target: number }[]>`select sell_target::float8 from public.v_plan_transition where plan_id = ${p.planId}`)[0];
      expect(t.sell_target).toBe(1000000);
    });
  });

  it("advises each folio's own units, and the switch-in to Direct is not an unadvised purchase", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx);
      const sm = await ctx.tx<{ id: string; scheme_name: string; isin: string }[]>`select id, scheme_name, isin from public.security_master where id in (${ctx.sec.X}, ${ctx.sec.Y})`;
      const X = sm.find((r) => r.id === ctx.sec.X)!;
      const Y = sm.find((r) => r.id === ctx.sec.Y)!;
      // X now sits in two folios: T1 6,000 units, T2 4,000 units.
      await ctx.as("ops", async (t) => {
        const pr = parsed("2026-09-20", [{ security: X.id, name: X.scheme_name, units: 6000, nav: 150 }, { security: X.id, name: X.scheme_name, units: 4000, nav: 150 }]);
        pr.holdings[0].isin = X.isin;
        pr.holdings[1].isin = X.isin;
        pr.holdings[1].folio_number = "T2";
        const id = await createSnapshotFromParsed(t, { clientId: p.clientId, casDocumentId: null, parsed: pr, source: "CAS", createdBy: ctx.users.ops.id });
        await confirmSnapshot(t, id, "checked");
      });
      const payload = advisoryReportResultSchema.parse({
        client_id: p.clientId, status: "PARSED", plan: { plan_name: "Two-folio migration" },
        items: [
          { action: "MIGRATE", scheme_name: X.scheme_name, folio_number: "T1", target_amount: 900000, current_amount: 900000, switch_to_scheme_name: Y.scheme_name, reason: "MIGRATE TO DIRECT" },
          { action: "MIGRATE", scheme_name: X.scheme_name, folio_number: "T2", target_amount: 600000, current_amount: 600000, switch_to_scheme_name: Y.scheme_name, reason: "MIGRATE TO DIRECT" },
        ],
      });
      const ids = { [X.scheme_name.toLowerCase()]: X.id, [Y.scheme_name.toLowerCase()]: Y.id };
      const draft = await ctx.as("advisor", (t) => ingestAdvisoryReport(t, payload, ctx.users.advisor.id, { extractionSource: "IMPORT", securityIds: ids }));
      await ctx.as("advisor", (t) => approvePlan(t, ctx.users.advisor, draft.planId!, "migration plan"));
      const planId = draft.planId!;
      const m = await ctx.as("advisor", (tx) => getMigrations(tx, planId));
      expect(m.map((x) => [x.folio_number, Number(x.regular_units_now)]).sort()).toEqual([["T1", 6000], ["T2", 4000]]);
      await ctx.as("advisor", (tx) => issueMigrationCalls(tx, ctx.users.advisor, {
        clientId: p.clientId, planId, planItemIds: m.map((x) => x.plan_item_id), channel: "PHONE", communicatedAt: new Date("2026-09-21T11:00:00+05:30"),
      }));
      const calls = await ctx.tx<{ folio_number: string; advised_units: number }[]>`
        select folio_number, advised_units::float8 from public.advice_items where client_id = ${p.clientId} and action = 'SWITCH' order by folio_number`;
      expect(calls).toEqual([{ folio_number: "T1", advised_units: 6000 }, { folio_number: "T2", advised_units: 4000 }]);

      // The CAS shows both switch-outs and the switch-ins to Direct.
      const snap = await ctx.as("ops", async (t) => {
        const pr = parsed("2026-09-25", [{ security: Y.id, name: Y.scheme_name, units: 15000, nav: 100 }], [
          { date: "2026-09-22", type: "SWITCH_OUT", scheme_name: X.scheme_name, isin: X.isin, folio_number: "T1", amount: -900000, units: -6000, nav: 150, balance_units: 0 },
          { date: "2026-09-22", type: "SWITCH_OUT", scheme_name: X.scheme_name, isin: X.isin, folio_number: "T2", amount: -600000, units: -4000, nav: 150, balance_units: 0 },
          { date: "2026-09-22", type: "SWITCH_IN", scheme_name: Y.scheme_name, isin: Y.isin, folio_number: "T1", amount: 1500000, units: 15000, nav: 100, balance_units: 15000 },
        ]);
        pr.holdings[0].isin = Y.isin;
        const id = await createSnapshotFromParsed(t, { clientId: p.clientId, casDocumentId: null, parsed: pr, source: "CAS", createdBy: ctx.users.ops.id });
        await confirmSnapshot(t, id, "checked");
        return id;
      });
      const { runId } = await ctx.as("ops", (t) => runReconciliation(t, ctx.users.ops, { clientId: p.clientId, currentSnapshotId: snap }));
      const rows = await ctx.tx<{ classification: string; n: number }[]>`
        select classification, count(*)::int as n from public.reconciliation_matches where run_id = ${runId} group by 1`;
      expect(rows).toEqual([{ classification: "ADVICE_MATCH", n: 2 }]);
      const open = await ctx.tx<{ n: number }[]>`select count(*)::int as n from public.v_advice_items where client_id = ${p.clientId} and action = 'SWITCH' and is_open`;
      expect(open[0].n).toBe(0);
    });
  });
});
