import { afterAll, describe, expect, it } from "vitest";
import { issueAdvice } from "@/services/advice";
import { recordExecution } from "@/services/executions";
import { getFundRows, getTranches } from "@/services/client-desk";
import { createClient, searchClients } from "@/services/clients";
import { addSipItem, setSipStatus } from "@/services/plans";
import { confirmSnapshot, createSnapshotFromParsed } from "@/services/portfolio";
import { clientWithActivePlan, parsed, progress, scenario, sql, TEST_DB } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});

describeDb("Client page: funds and tranches", () => {
  it("shows per-fund plan progress with dates, from the views, and puts calls in the open tranche", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx); // SELL X ₹10L, BUY Y ₹6L, CAS of 01-Sep
      const call = await ctx.as("advisor", (t) => issueAdvice(t, ctx.users.advisor, {
        clientId: p.clientId, communicatedAt: new Date("2026-09-10T10:00:00+05:30"), channel: "PHONE",
        items: [{ plan_item_id: p.sellItem, security_id: ctx.sec.X, action: "SELL", quantity_basis: "AMOUNT", advised_amount: 300000 }],
      }));
      await ctx.as("ops", (t) => recordExecution(t, ctx.users.ops, {
        adviceItemId: call.itemIds[0], executionDate: "2026-09-12", executedAmount: 250000, executedUnits: null, verificationType: "CLIENT_CONFIRMED",
      }));

      const { rows, totals } = await ctx.as("advisor", (t) => getFundRows(t, p.clientId));
      const x = rows.find((r) => r.securityId === ctx.sec.X)!;
      const y = rows.find((r) => r.securityId === ctx.sec.Y)!;
      const v = await progress(ctx, p.sellItem);
      expect(x.plan).toMatchObject({ tone: "sell", advised: v.advised_amount, executed: v.executed_amount, pending: v.pending_amount, remaining: v.yet_to_advise_amount });
      expect(x.advisedDates).toEqual(["10-Sep"]);
      expect(x.executedDates).toEqual(["12-Sep"]);
      expect(x.events.map((e) => e.kind)).toEqual(expect.arrayContaining(["PLAN", "CALL", "EXECUTED"]));
      expect(x.onboardingValue).toBe(1500000);
      expect(y).toMatchObject({ notHeld: true, plan: { tone: "buy", remaining: 600000 } });
      expect(rows[0].securityId).toBe(ctx.sec.X); // sells first
      expect(totals).toMatchObject({ sellTarget: 1000000, buyTarget: 600000, executed: 250000 });

      const { tranches, ledger, baseline } = await ctx.as("advisor", (t) => getTranches(t, p.clientId));
      expect(baseline?.date).toBe("2026-09-01");
      expect(tranches).toHaveLength(1);
      expect(tranches[0]).toMatchObject({ number: 1, open: true, calls: 1, advisedSell: 300000, executedSell: 250000, pending: 50000 });
      expect(ledger[0]).toMatchObject({ tranche: 1, advisedOn: "2026-09-10", executed: 250000, executedOn: "2026-09-12" });
    });
  });
});

describeDb("Tranches keep SIPs apart from lump-sum Buy & Sell", () => {
  it("counts a SIP line and its instalments in the SIP part of the tranche, never in Buy", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx); // CAS of 01-Sep
      const y = (await ctx.tx<{ scheme_name: string; isin: string }[]>`select scheme_name, isin from public.security_master where id = ${ctx.sec.Y}`)[0];
      const x = (await ctx.tx<{ scheme_name: string; isin: string }[]>`select scheme_name, isin from public.security_master where id = ${ctx.sec.X}`)[0];
      const sipId = await ctx.as("advisor", (t) => addSipItem(t, ctx.users.advisor, p.planId, { security_id: ctx.sec.Y, scheme_name: y.scheme_name, action: "START", new_amount: 10000 }, "added for the test"));
      await ctx.as("advisor", (t) => setSipStatus(t, sipId, "ADVISED", "told on call"));
      await ctx.tx`update public.sip_plan_items set advised_at = '2026-09-03T10:00:00+05:30' where id = ${sipId}`;
      // Next CAS (05-Oct): two instalments of the SIP, one worded the way an older reader stored it.
      await ctx.as("ops", async (t) => {
        const pr = parsed("2026-10-05", [{ security: ctx.sec.X, name: x.scheme_name, units: 10000, nav: 150 }, { security: ctx.sec.Y, name: y.scheme_name, units: 200, nav: 100 }], [
          { date: "2026-09-05", type: "SIP", scheme_name: y.scheme_name, isin: y.isin, folio_number: "T1", amount: 10000, units: 100, nav: 100, balance_units: 100 },
          { date: "2026-10-05", type: "PURCHASE", description: "Sys. Investment (2/120)", scheme_name: y.scheme_name, isin: y.isin, folio_number: "T1", amount: 10000, units: 100, nav: 100, balance_units: 200 },
        ]);
        pr.holdings[0].isin = x.isin;
        pr.holdings[1].isin = y.isin;
        const id = await createSnapshotFromParsed(t, { clientId: p.clientId, casDocumentId: null, parsed: pr, source: "CAS", createdBy: ctx.users.ops.id });
        await confirmSnapshot(t, id, "checked");
      });
      const { tranches, sipLedger } = await ctx.as("advisor", (t) => getTranches(t, p.clientId));
      const t1 = tranches.find((t) => t.number === 1)!;
      expect(t1).toMatchObject({ to: "2026-10-05", advisedBuy: 0, executedBuy: 0 });
      expect(t1.sip).toMatchObject({ lines: 1, starts: 1, monthly: 10000, instalments: 2, invested: 20000 });
      expect(sipLedger).toHaveLength(1);
      expect(sipLedger[0]).toMatchObject({ tranche: 1, action: "START", newAmount: 10000, advisedOn: "2026-09-03" });
    });
  });
});

describeDb("Finding a client while typing", () => {
  it("matches every word of the name, the client ID or phone digits, names starting with the text first", async () => {
    await scenario(async (ctx) => {
      const a = await ctx.as("advisor", (t) => createClient(t, ctx.users.advisor, { full_name: "Zarina Qadri Test", phone: "98765 43210", status: "ACTIVE" }));
      await ctx.as("advisor", (t) => createClient(t, ctx.users.advisor, { full_name: "Test Zarina Other", status: "ACTIVE" }));
      const names = async (q: string) => (await ctx.as("advisor", (t) => searchClients(t, q))).map((h) => h.full_name);
      expect(await names("zar qad")).toEqual(["Zarina Qadri Test"]);
      expect((await names("zarina"))[0]).toBe("Zarina Qadri Test");
      expect(await names("43210")).toContain("Zarina Qadri Test");
      expect(await names(a.client_code)).toEqual(["Zarina Qadri Test"]);
      expect(await names("")).toEqual([]);
      expect(await ctx.as("otherAdvisor", (t) => searchClients(t, "zarina"))).toEqual([]);
    });
  });
});
