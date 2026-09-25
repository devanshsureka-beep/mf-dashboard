import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { issueAdvice } from "@/services/advice";
import { recordExecution } from "@/services/executions";
import { confirmSnapshot, createSnapshotFromParsed } from "@/services/portfolio";
import { runReconciliation } from "@/services/reconciliation";
import { ingestParsedCas } from "@/services/cas-intake";
import { ensureClientFromDocuments, onboardFromDocuments } from "@/services/onboarding";
import { resolveOrCreateSecurity } from "@/services/securities";
import { parseCasLines } from "@/lib/parsers/cas";
import { parseAdvisoryReportLines } from "@/lib/parsers/advisory-report";
import { clientWithActivePlan, parsed, progress, scenario, sql, TEST_DB, type Ctx } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});

async function names(ctx: Ctx) {
  const rows = await ctx.tx<{ id: string; scheme_name: string; isin: string }[]>`select id, scheme_name, isin from public.security_master where id in (${ctx.sec.X}, ${ctx.sec.Y}, ${ctx.sec.Z})`;
  return (id: string) => rows.find((r) => r.id === id)!;
}

const file = (name: string) => ({ fileName: name, mimeType: "application/pdf", size: 1000, sha256: randomUUID().replace(/-/g, "").padEnd(64, "0"), path: `x/${name}` });

describeDb("CAS transactions prove execution (engine v2)", () => {
  it("auto-confirms clear matches with the CAS date/amount/NAV, verifies manual entries, flags unadvised, ticks SIP starts", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx);
      const n = await names(ctx);
      // Plan also says: start a ₹2,000 SIP in Y.
      await ctx.as("advisor", (t) => t`
        insert into public.sip_plan_items (client_id, plan_id, security_id, scheme_name, action, new_amount, advised_at)
        values (${p.clientId}, ${p.planId}, ${ctx.sec.Y}, 'Y', 'START', 2000, '2026-09-10T10:30:00+05:30')`, "SIP added in test");

      // Day 1 (10-Sep 10:30 IST): SELL X ₹3,00,000 and BUY Y ₹2,00,000.
      const b = await ctx.as("advisor", (t) => issueAdvice(t, ctx.users.advisor, {
        clientId: p.clientId, communicatedAt: new Date("2026-09-10T10:30:00+05:30"), channel: "PHONE",
        items: [
          { plan_item_id: p.sellItem, security_id: ctx.sec.X, action: "SELL", quantity_basis: "AMOUNT", advised_amount: 300000 },
          { plan_item_id: p.buyItem, security_id: ctx.sec.Y, action: "BUY", quantity_basis: "AMOUNT", advised_amount: 200000 },
        ],
      }));
      // The client told us about the purchase; the CAS should verify it, not duplicate it.
      await ctx.as("ops", (t) => recordExecution(t, ctx.users.ops, {
        adviceItemId: b.itemIds[1], executionDate: "2026-09-11", executedAmount: 200000, verificationType: "CLIENT_CONFIRMED",
      }));

      const tx = (o: Partial<ReturnType<typeof parsed>["transactions"][number]> & { date: string; type: ReturnType<typeof parsed>["transactions"][number]["type"]; scheme_name: string }) =>
        ({ folio_number: "T1", ...o });
      const snap = await ctx.as("ops", async (t) => {
        const pr = parsed("2026-09-16", [
          { security: ctx.sec.X, name: n(ctx.sec.X).scheme_name, units: 8009.07, nav: 150 },
          { security: ctx.sec.Y, name: n(ctx.sec.Y).scheme_name, units: 2019.9, nav: 100 },
          { security: ctx.sec.Z, name: n(ctx.sec.Z).scheme_name, units: 250, nav: 20 },
        ], [
          tx({ date: "2026-09-10", type: "REDEMPTION", scheme_name: n(ctx.sec.X).scheme_name, isin: n(ctx.sec.X).isin, amount: -298640, units: -1990.93, nav: 150, balance_units: 8009.07 }),
          tx({ date: "2026-09-11", type: "PURCHASE", scheme_name: n(ctx.sec.Y).scheme_name, isin: n(ctx.sec.Y).isin, amount: 199990, units: 1999.9, nav: 100, balance_units: 1999.9 }),
          tx({ date: "2026-09-11", type: "STAMP_DUTY", scheme_name: n(ctx.sec.Y).scheme_name, isin: n(ctx.sec.Y).isin, amount: 10 }),
          tx({ date: "2026-09-12", type: "PURCHASE", scheme_name: n(ctx.sec.Z).scheme_name, isin: n(ctx.sec.Z).isin, amount: 5000, units: 250, nav: 20, balance_units: 250 }),
          tx({ date: "2026-09-15", type: "SIP", scheme_name: n(ctx.sec.Y).scheme_name, isin: n(ctx.sec.Y).isin, amount: 2000, units: 20, nav: 100, balance_units: 2019.9 }),
        ]);
        pr.holdings.forEach((h, i) => { h.isin = n([ctx.sec.X, ctx.sec.Y, ctx.sec.Z][i]).isin; });
        const id = await createSnapshotFromParsed(t, { clientId: p.clientId, casDocumentId: null, parsed: pr, source: "CAS", createdBy: ctx.users.ops.id });
        await confirmSnapshot(t, id, "checked");
        return id;
      });

      const { runId } = await ctx.as("ops", (t) => runReconciliation(t, ctx.users.ops, { clientId: p.clientId, currentSnapshotId: snap }));
      const run = (await ctx.tx<{ engine_version: string; status: string; summary: Record<string, number> }[]>`
        select engine_version, status, summary from public.reconciliation_runs where id = ${runId}`)[0];
      expect(run.engine_version).toBe("v2-transactions");
      expect(run.summary).toMatchObject({ advice_matches: 2, auto_confirmed: 2, unadvised: 1, sip_instalments: 1, sip_items_completed: 1 });
      expect(run.status).toBe("OPEN"); // the unadvised purchase still needs a person

      // SELL: a new CAS_VERIFIED execution with the CAS facts.
      const sellExec = await ctx.tx<{ execution_date: string; executed_amount: number; executed_units: number; execution_price: number; verification_type: string }[]>`
        select execution_date::text, executed_amount, executed_units, execution_price, verification_type
        from public.executions where advice_item_id = ${b.itemIds[0]}`;
      expect(sellExec).toEqual([{ execution_date: "2026-09-10", executed_amount: 298640, executed_units: 1990.93, execution_price: 150, verification_type: "CAS_VERIFIED" }]);
      const call = (await ctx.tx<{ status: string }[]>`select status from public.advice_items where id = ${b.itemIds[0]}`)[0];
      expect(call.status).toBe("EXECUTED"); // within the 1% NAV tolerance
      expect((await progress(ctx, p.sellItem)).executed_amount).toBe(298640);

      // BUY: manual execution verified, nothing duplicated.
      const buyExec = await ctx.tx<{ n: number; verified: number }[]>`
        select count(*)::int as n, count(cas_verified_at)::int as verified from public.executions where advice_item_id = ${b.itemIds[1]}`;
      expect(buyExec[0]).toEqual({ n: 1, verified: 1 });

      // Timing: same day for the sell, +1 day for the buy.
      const timing = await ctx.as("ops", (t) => t<{ advice_item_id: string; lag_days: number; cas_verified: boolean }[]>`
        select advice_item_id, lag_days, cas_verified from public.v_advice_execution_timing where advice_item_id in (${b.itemIds[0]}, ${b.itemIds[1]})`);
      expect(Object.fromEntries(timing.map((r) => [r.advice_item_id, [r.lag_days, r.cas_verified]]))).toEqual({
        [b.itemIds[0]]: [0, true], [b.itemIds[1]]: [1, true],
      });

      const matches = await ctx.tx<{ classification: string; status: string; auto_confirmed: boolean; transaction_date: string; transaction_amount: number }[]>`
        select classification, status, auto_confirmed, transaction_date::text, transaction_amount from public.reconciliation_matches where run_id = ${runId} order by transaction_date, classification`;
      expect(matches.map((m) => [m.classification, m.status, m.auto_confirmed, m.transaction_date])).toEqual([
        ["ADVICE_MATCH", "CONFIRMED", true, "2026-09-10"],
        ["ADVICE_MATCH", "CONFIRMED", true, "2026-09-11"],
        ["UNADVISED", "UNEXPLAINED", false, "2026-09-12"],
        ["SIP_INSTALMENT", "UNEXPLAINED", false, "2026-09-15"],
      ]);
      const sip = (await ctx.tx<{ status: string }[]>`select status from public.sip_plan_items where plan_id = ${p.planId}`)[0];
      expect(sip.status).toBe("COMPLETED");

      // Evidence on a match is immutable.
      const err = await ctx.expectError("ops", (t) => t`update public.reconciliation_matches set transaction_amount = 1 where run_id = ${runId}`);
      expect(err).toMatch(/cannot be changed|immutable|transaction_amount/i);
    });
  });

  it("a transaction dated before the call is never counted as its execution", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx);
      const n = await names(ctx);
      const b = await ctx.as("advisor", (t) => issueAdvice(t, ctx.users.advisor, {
        clientId: p.clientId, communicatedAt: new Date("2026-09-12T09:00:00+05:30"), channel: "PHONE",
        items: [{ plan_item_id: p.sellItem, security_id: ctx.sec.X, action: "SELL", quantity_basis: "AMOUNT", advised_amount: 150000 }],
      }));
      const snap = await ctx.as("ops", async (t) => {
        const pr = parsed("2026-09-16", [{ security: ctx.sec.X, name: n(ctx.sec.X).scheme_name, units: 9000, nav: 150 }], [
          { date: "2026-09-11", type: "REDEMPTION", scheme_name: n(ctx.sec.X).scheme_name, isin: n(ctx.sec.X).isin, folio_number: "T1", amount: -150000, units: -1000, nav: 150, balance_units: 9000 },
        ]);
        pr.holdings[0].isin = n(ctx.sec.X).isin;
        const id = await createSnapshotFromParsed(t, { clientId: p.clientId, casDocumentId: null, parsed: pr, source: "CAS", createdBy: ctx.users.ops.id });
        await confirmSnapshot(t, id, "checked");
        return id;
      });
      await ctx.as("ops", (t) => runReconciliation(t, ctx.users.ops, { clientId: p.clientId, currentSnapshotId: snap }));
      const execs = await ctx.tx`select 1 from public.executions where advice_item_id = ${b.itemIds[0]}`;
      expect(execs).toHaveLength(0);
      const m = await ctx.tx<{ classification: string }[]>`select classification from public.reconciliation_matches where client_id = ${p.clientId}`;
      expect(m.map((x) => x.classification)).toEqual(["UNADVISED"]);
    });
  });
});

describeDb("onboarding from CAS + advisory report", () => {
  const cas = parseCasLines(readFileSync("tests/fixtures/cas-kfin-cams.sample.txt", "utf8").split("\n"));
  const report = parseAdvisoryReportLines(readFileSync("tests/fixtures/univest-report.sample.txt", "utf8").split("\n"));

  it("creates the client by PAN, a confirmed baseline snapshot and a DRAFT plan; a second report adds a new draft", async () => {
    await scenario(async (ctx) => {
      const client = await ctx.as("advisor", (t) => ensureClientFromDocuments(t, ctx.users.advisor, { cas, report, phone: null }));
      expect(client.created).toBe(true);
      const out = await ctx.as("advisor", (t) => onboardFromDocuments(t, ctx.users.advisor, {
        clientId: client.id, cas, casFile: { ...file("cas.pdf"), passwordProtected: true }, report, reportFile: file("report.pdf"),
      }));

      const c = (await ctx.tx<{ pan: string; phone: string; email: string; risk_profile: string; status: string }[]>`
        select pan, phone, email, risk_profile, status from public.clients where id = ${client.id}`)[0];
      expect(c).toEqual({ pan: "ABCPT1234Q", phone: "9800001234", email: "test.investor@example.com", risk_profile: "MODERATE", status: "ACTIVE" });

      const snap = (await ctx.tx<{ review_status: string; is_baseline: boolean; holdings_count: number }[]>`
        select review_status, is_baseline, holdings_count from public.portfolio_snapshots where id = ${out.snapshotId}`)[0];
      expect(snap).toMatchObject({ review_status: "CONFIRMED", is_baseline: true });
      expect(snap.holdings_count).toBeGreaterThan(0);

      const plan = (await ctx.tx<{ status: string; extraction_source: string; target_buy_value: number }[]>`
        select status, extraction_source, target_buy_value from public.advisory_plans where id = ${out.planId}`)[0];
      expect(plan).toMatchObject({ status: "DRAFT", extraction_source: "IMPORT" });
      expect(Math.abs(plan.target_buy_value - (report.buyTotal ?? 0))).toBeLessThan(2);
      const items = await ctx.tx<{ action: string; n: number; unresolved: number }[]>`
        select action, count(*)::int as n, count(*) filter (where security_id is null)::int as unresolved
        from public.advisory_plan_items where plan_id = ${out.planId} group by action order by action`;
      const byAction = Object.fromEntries(items.map((i) => [i.action, i]));
      expect(byAction.BUY).toMatchObject({ n: 8, unresolved: 0 }); // name-only securities created
      expect(byAction.RETAIN.n).toBe(snap.holdings_count);        // the report's sells are not in this CAS fixture
      expect(out.warnings.some((w) => /not found in the CAS/.test(w))).toBe(true);

      // A new report for the same client (same PAN) -> a new DRAFT, same client.
      const again = await ctx.as("advisor", (t) => ensureClientFromDocuments(t, ctx.users.advisor, { cas, report }));
      expect(again).toMatchObject({ id: client.id, created: false });
      const second = await ctx.as("advisor", (t) => onboardFromDocuments(t, ctx.users.advisor, {
        clientId: client.id, cas, casFile: { ...file("cas.pdf"), passwordProtected: true }, report, reportFile: file("report2.pdf"),
      }));
      expect(second.planId).not.toBe(out.planId);
      // Same valuation date and value: flagged as a possible duplicate, so NOT auto-confirmed.
      const s2 = await ctx.tx<{ review_status: string }[]>`select review_status from public.portfolio_snapshots where id = ${second.snapshotId}`;
      expect(s2[0].review_status).toBe("PENDING_REVIEW");
    });
  });

  it("refuses a report that belongs to someone else", async () => {
    await scenario(async (ctx) => {
      const other = { ...report, clientName: "Somebody Else Entirely" };
      const msg = await ctx.expectError("advisor", (t) => ensureClientFromDocuments(t, ctx.users.advisor, { cas, report: other }));
      expect(msg).toMatch(/report is for/);
    });
  });

  it("a fund bought by name picks up its ISIN from the first CAS that holds it", async () => {
    await scenario(async (ctx) => {
      const tag = randomUUID().slice(0, 4).replace(/\d/g, "q");
      const nameOnly = await ctx.as("advisor", (t) => resolveOrCreateSecurity(t, { scheme_name: `Zephyr ${tag} Opportunities Fund (Direct)`, plan_type: "DIRECT" }, ctx.users.advisor.id));
      const isin = `INF${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}Z1`;
      const fromCas = await ctx.as("ops", (t) => resolveOrCreateSecurity(t, { isin, scheme_name: `Zephyr ${tag} Opportunities Fund - Direct Plan - Growth` }, ctx.users.ops.id));
      expect(fromCas).toBe(nameOnly);
      const row = (await ctx.tx<{ isin: string }[]>`select isin from public.security_master where id = ${nameOnly}`)[0];
      expect(row.isin).toBe(isin);
      // A Regular-plan ISIN never attaches to the Direct entry.
      const reg = await ctx.as("ops", (t) => resolveOrCreateSecurity(t, { isin: `INF${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}R2`, scheme_name: `Zephyr ${tag} Opportunities Fund - Regular Plan - Growth` }, ctx.users.ops.id));
      expect(reg).not.toBe(nameOnly);
    });
  });

  it("ingestParsedCas matches the CAS to nobody else's client and refuses duplicates", async () => {
    await scenario(async (ctx) => {
      const client = await ctx.as("advisor", (t) => ensureClientFromDocuments(t, ctx.users.advisor, { cas, report }));
      const f = file("a.pdf");
      await ctx.as("ops", (t) => ingestParsedCas(t, ctx.users.ops, { clientId: client.id, file: f, parsed: cas, passwordProtected: false }))
        .catch((e) => { throw e; });
      const msg = await ctx.expectError("advisor", (t) => ingestParsedCas(t, ctx.users.advisor, { clientId: client.id, file: f, parsed: cas, passwordProtected: false }));
      expect(msg).toMatch(/already been uploaded/);
    });
  });
});
