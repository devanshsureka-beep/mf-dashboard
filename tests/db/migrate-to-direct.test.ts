import { afterAll, describe, expect, it } from "vitest";
import { advisoryReportResultSchema } from "@/lib/integrations/contracts";
import { convertMigrateNotes, countMigrateNotes } from "@/services/migrations";
import { issueAdvice, linkCallsToPlan } from "@/services/advice";
import { addPlanItem, approvePlan, ingestAdvisoryReport } from "@/services/plans";
import { ingestNavFeed } from "@/services/nav";
import { resolveFundRef } from "@/services/fund-search";
import { confirmSnapshot, createSnapshotFromParsed } from "@/services/portfolio";
import { recordAdvisedOffline, runReconciliation } from "@/services/reconciliation";
import { clientWithActivePlan, parsed, scenario, sql, TEST_DB, type Ctx } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});

/** Replace the plan with: Migrate X (Regular) to Y (Direct), ₹15L; buy Y ₹1L. */
async function migratePlan(ctx: Ctx, clientId: string) {
  const names = await ctx.tx<{ id: string; scheme_name: string }[]>`select id, scheme_name from public.security_master where id in (${ctx.sec.X}, ${ctx.sec.Y})`;
  const nameOf = (id: string) => names.find((n) => n.id === id)!.scheme_name;
  const payload = advisoryReportResultSchema.parse({
    client_id: clientId, status: "PARSED",
    plan: { plan_name: "Rebalancing with migration" },
    items: [
      { action: "MIGRATE", scheme_name: nameOf(ctx.sec.X), target_amount: 1500000, current_amount: 1500000, switch_to_scheme_name: nameOf(ctx.sec.Y), reason: "MIGRATE TO DIRECT; Hold" },
      { action: "BUY", scheme_name: nameOf(ctx.sec.Y), target_amount: 100000 },
    ],
    declared_totals: { exit_value: 0, buy_value: 100000 },
  });
  const ids = { [nameOf(ctx.sec.X).toLowerCase()]: ctx.sec.X, [nameOf(ctx.sec.Y).toLowerCase()]: ctx.sec.Y };
  const draft = await ctx.as("advisor", (t) => ingestAdvisoryReport(t, payload, ctx.users.advisor.id, { extractionSource: "IMPORT", securityIds: ids }));
  await ctx.as("advisor", (t) => approvePlan(t, ctx.users.advisor, draft.planId!, "replace with migration plan"));
  return { planId: draft.planId!, warnings: draft.warnings };
}

describeDb("Plan lines are Buy, Sell or Keep", () => {
  it("stores a Migrate to Direct from the report as a Sell of the Regular plan and a Buy of the Direct plan", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx);
      const { planId, warnings } = await migratePlan(ctx, p.clientId);
      // The report's totals leave out the migration: no false mismatch.
      expect(warnings).toEqual([]);
      const lines = await ctx.tx<{ action: string; security_id: string; target_amount: number; reason: string | null }[]>`
        select action, security_id, target_amount::float8, reason from public.advisory_plan_items where plan_id = ${planId} order by priority, action desc`;
      expect(lines).toEqual([
        { action: "SELL", security_id: ctx.sec.X, target_amount: 1500000, reason: "Migrate to Direct: redeem the Regular plan; Hold" },
        { action: "BUY", security_id: ctx.sec.Y, target_amount: 1500000, reason: "Migrate to Direct: buy the Direct plan with the Regular redemption" },
        { action: "BUY", security_id: ctx.sec.Y, target_amount: 100000, reason: null },
      ]);
      const t = (await ctx.tx<{ sell_target: number; buy_target: number }[]>`
        select sell_target::float8, buy_target::float8 from public.v_plan_transition where plan_id = ${planId}`)[0];
      expect(t).toEqual({ sell_target: 1500000, buy_target: 1600000 });

      // No Migrate or Switch lines can be added any more.
      await expect(ctx.asSuper((tx) => tx`
        insert into public.advisory_plan_items (plan_id, security_id, scheme_name, action, target_amount)
        values (${planId}, ${ctx.sec.X}, 'x', 'MIGRATE', 1)`)).rejects.toThrow(/Buy, Sell or Keep/);
    });
  });

  it("links a CAS redemption and the Direct buy to the Sell and Buy lines; an admin links earlier calls by fund", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx); // X 10,000 units @150
      const { planId } = await migratePlan(ctx, p.clientId);
      const x = (await ctx.tx<{ scheme_name: string; isin: string }[]>`select scheme_name, isin from public.security_master where id = ${ctx.sec.X}`)[0];
      const snap = await ctx.as("ops", async (t) => {
        const pr = parsed("2026-09-16", [{ security: ctx.sec.X, name: x.scheme_name, units: 8000, nav: 150 }], [
          { date: "2026-09-12", type: "REDEMPTION", scheme_name: x.scheme_name, isin: x.isin, folio_number: "T1", amount: -300000, units: -2000, nav: 150, balance_units: 8000 },
        ]);
        pr.holdings[0].isin = x.isin;
        const id = await createSnapshotFromParsed(t, { clientId: p.clientId, casDocumentId: null, parsed: pr, source: "CAS", createdBy: ctx.users.ops.id });
        await confirmSnapshot(t, id, "checked");
        return id;
      });
      const { runId } = await ctx.as("ops", (t) => runReconciliation(t, ctx.users.ops, { clientId: p.clientId, currentSnapshotId: snap }));
      const unadvised = (await ctx.tx<{ id: string }[]>`
        select id from public.reconciliation_matches where run_id = ${runId} and classification = 'UNADVISED'`)[0];
      const out = await ctx.as("advisor", (t) => recordAdvisedOffline(t, ctx.users.advisor, unadvised.id, { channel: "PHONE" }));
      const sellLine = (await ctx.tx<{ id: string }[]>`select id from public.advisory_plan_items where plan_id = ${planId} and action = 'SELL'`)[0].id;
      expect(out.planItemId).toBe(sellLine);

      // Calls given without a plan line: the Direct buy goes on its Buy line; a fund the plan does not
      // cover gets a Buy line of its own (and it grows with a further call). Nothing stays outside the plan.
      const loose = await ctx.as("advisor", (t) => issueAdvice(t, ctx.users.advisor, {
        clientId: p.clientId, communicatedAt: new Date("2026-09-17T10:00:00+05:30"), channel: "PHONE",
        items: [
          { security_id: ctx.sec.Y, action: "BUY", quantity_basis: "AMOUNT", advised_amount: 300000 },
          { security_id: ctx.sec.Z, action: "BUY", quantity_basis: "AMOUNT", advised_amount: 50000 },
        ],
      }));
      await ctx.as("advisor", (t) => issueAdvice(t, ctx.users.advisor, {
        clientId: p.clientId, communicatedAt: new Date("2026-09-18T10:00:00+05:30"), channel: "PHONE",
        items: [{ security_id: ctx.sec.Z, action: "BUY", quantity_basis: "AMOUNT", advised_amount: 25000 }],
      }));
      const lineOf = async (itemId: string) => (await ctx.tx<{ action: string; target_amount: number; reason: string }[]>`
        select pi.action, pi.target_amount::float8, pi.reason from public.advice_items ai join public.advisory_plan_items pi on pi.id = ai.plan_item_id
        where ai.id = ${itemId}`)[0];
      expect(await lineOf(loose.itemIds[0])).toMatchObject({ action: "BUY", target_amount: 1500000 });
      expect(await lineOf(loose.itemIds[1])).toMatchObject({ action: "BUY", target_amount: 75000, reason: expect.stringMatching(/^Advised outside the report/) });
      const offPlan = async () => (await ctx.as("advisor", (t) => t<{ sell: number; buy: number }[]>`
        select off_plan_sell_advised::float8 as sell, off_plan_buy_advised::float8 as buy from public.v_client_rebalance_extra where client_id = ${p.clientId}`))[0];
      expect(await offPlan()).toEqual({ sell: 0, buy: 0 });

      // A call recorded before its line existed (no plan link): only an admin re-links it, onto its fund's line.
      await ctx.asSuper(async (t) => {
        await t`set local session_replication_role = replica`;
        await t`update public.advice_items set plan_item_id = null where id = ${loose.itemIds[0]}`;
        await t`set local session_replication_role = origin`;
      });
      expect(await offPlan()).toEqual({ sell: 0, buy: 300000 });
      await expect(ctx.as("advisor", (t) => linkCallsToPlan(t, ctx.users.advisor, p.clientId))).rejects.toThrow(/Only an admin/);
      expect(await ctx.as("admin", (t) => linkCallsToPlan(t, ctx.users.admin, p.clientId))).toEqual({ linked: 1, left: 0 });
      expect(await lineOf(loose.itemIds[0])).toMatchObject({ action: "BUY", target_amount: 1500000 });
      expect(await offPlan()).toEqual({ sell: 0, buy: 0 });
    });
  });

  it("a sell on a fund the plan keeps turns its Keep line into a Sell, answering an open question", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx);
      const z = (await ctx.tx<{ scheme_name: string }[]>`select scheme_name from public.security_master where id = ${ctx.sec.Z}`)[0];
      const keep = await ctx.as("advisor", (t) => addPlanItem(t, ctx.users.advisor, p.planId, {
        security_id: ctx.sec.Z, scheme_name: z.scheme_name, action: "RETAIN", target_amount: 0, current_amount: 400000, reason: "Report: Trim (no amount given)",
      }, "test: trim with no amount"));
      await ctx.asSuper((t) => t`update public.advisory_plan_items set report_question = 'How much should be sold?', needs_review = true where id = ${keep}`);
      const call = await ctx.as("advisor", (t) => issueAdvice(t, ctx.users.advisor, {
        clientId: p.clientId, communicatedAt: new Date("2026-09-17T10:00:00+05:30"), channel: "PHONE",
        items: [{ security_id: ctx.sec.Z, action: "SELL", quantity_basis: "AMOUNT", advised_amount: 120000 }],
      }));
      const line = (await ctx.tx<{ id: string; action: string; target_amount: number; needs_review: boolean; report_answer: string }[]>`
        select pi.id, pi.action, pi.target_amount::float8, pi.needs_review, pi.report_answer
        from public.advice_items ai join public.advisory_plan_items pi on pi.id = ai.plan_item_id where ai.id = ${call.itemIds[0]}`)[0];
      expect(line).toMatchObject({ id: keep, action: "SELL", target_amount: 120000, needs_review: false, report_answer: "Sold ₹1,20,000 on advice" });
    });
  });

  it("turns Migrate to Direct notes on Keep lines into a Sell + a Buy of the AMFI Direct plan", async () => {
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
      const keep = await ctx.as("advisor", (t) => addPlanItem(t, ctx.users.advisor, p.planId, {
        security_id: regSec, scheme_name: `Zeta ${tag} Flexi Cap Fund - Regular Plan - Growth`, action: "RETAIN", target_amount: 0,
        current_amount: 300000, reason: "Kept for now: Migrate to Direct; Hold",
      }, "test: old-style plan line"));
      expect(await ctx.as("advisor", (t) => countMigrateNotes(t, p.planId))).toBe(1);

      expect(await ctx.as("advisor", (t) => convertMigrateNotes(t, ctx.users.advisor, p.planId))).toBe(1);
      const dirSec = (await ctx.tx<{ id: string }[]>`select id from public.security_master where isin = ${dir}`)[0].id;
      const lines = await ctx.tx<{ id: string; action: string; security_id: string; target_amount: number; reason: string }[]>`
        select id, action, security_id, target_amount::float8, reason from public.advisory_plan_items
        where plan_id = ${p.planId} and security_id in (${regSec}, ${dirSec}) order by action desc`;
      expect(lines).toEqual([
        { id: keep, action: "SELL", security_id: regSec, target_amount: 300000, reason: "Migrate to Direct: redeem the Regular plan; Hold" },
        { id: expect.any(String), action: "BUY", security_id: dirSec, target_amount: 300000, reason: "Migrate to Direct: buy the Direct plan with the Regular redemption" },
      ]);
      expect(await ctx.as("advisor", (t) => countMigrateNotes(t, p.planId))).toBe(0);
      const t = (await ctx.tx<{ sell_target: number; buy_target: number }[]>`select sell_target::float8, buy_target::float8 from public.v_plan_transition where plan_id = ${p.planId}`)[0];
      expect(t).toEqual({ sell_target: 1300000, buy_target: 900000 });
    });
  });

  it("keeps a Sell line per folio; a switch done by the client matches the sell and buy calls", async () => {
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
      const sells = await ctx.tx<{ id: string; folio_number: string }[]>`
        select id, folio_number from public.advisory_plan_items where plan_id = ${planId} and action = 'SELL' order by folio_number`;
      expect(sells.map((x) => x.folio_number)).toEqual(["T1", "T2"]);
      const buy = (await ctx.tx<{ id: string }[]>`select id from public.advisory_plan_items where plan_id = ${planId} and action = 'BUY'`)[0].id;
      // Sell each folio of the Regular plan, buy the Direct plan: the client does it as a switch.
      await ctx.as("advisor", (tx) => issueAdvice(tx, ctx.users.advisor, {
        clientId: p.clientId, communicatedAt: new Date("2026-09-21T11:00:00+05:30"), channel: "PHONE",
        items: [
          ...sells.map((x, k) => ({ plan_item_id: x.id, security_id: X.id, folio_number: x.folio_number, action: "SELL" as const, quantity_basis: "UNITS" as const, advised_units: k ? 4000 : 6000, advised_amount: k ? 600000 : 900000 })),
          { plan_item_id: buy, security_id: Y.id, action: "BUY" as const, quantity_basis: "AMOUNT" as const, advised_amount: 1500000 },
        ],
      }));
      const calls = await ctx.tx<{ folio_number: string; advised_units: number }[]>`
        select folio_number, advised_units::float8 from public.advice_items where client_id = ${p.clientId} and action = 'SELL' order by folio_number`;
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
      // Both switch-outs match the sells, the switch-in matches the buy: nothing unadvised.
      expect(rows).toEqual([{ classification: "ADVICE_MATCH", n: 3 }]);
      const open = await ctx.tx<{ n: number }[]>`select count(*)::int as n from public.v_advice_items where client_id = ${p.clientId} and is_open`;
      expect(open[0].n).toBe(0);
    });
  });
});
