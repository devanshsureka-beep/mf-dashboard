import { afterAll, describe, expect, it } from "vitest";
import { issueAdvice } from "@/services/advice";
import { recordExecution } from "@/services/executions";
import { getCasInbox } from "@/services/cas-inbox";
import { clientWithActivePlan, scenario, sql, TEST_DB } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});

describeDb("CAS inbox: what to collect", () => {
  it("lists a client whose advice no CAS has shown yet, with the amount waiting", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx); // CAS of 01-Sep, SELL X ₹10L
      await ctx.as("advisor", (t) => issueAdvice(t, ctx.users.advisor, {
        clientId: p.clientId, communicatedAt: new Date("2026-09-10T10:00:00+05:30"), channel: "PHONE",
        items: [{ plan_item_id: p.sellItem, security_id: ctx.sec.X, action: "SELL", quantity_basis: "AMOUNT", advised_amount: 300000 }],
      }));
      const inbox = await ctx.as("advisor", (t) => getCasInbox(t));
      const row = inbox.collect.find((c) => c.client_id === p.clientId);
      expect(row).toMatchObject({ waiting_amount: 300000, unverified_amount: 0, latest_cas: "2026-09-01" });
      expect(inbox.confirm.find((c) => c.client_id === p.clientId)).toBeUndefined();
    });
  });

  it("counts money in bank only from trades the latest CAS already shows", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx); // latest CAS 01-Sep
      const call = await ctx.as("advisor", (t) => issueAdvice(t, ctx.users.advisor, {
        clientId: p.clientId, communicatedAt: new Date("2026-09-10T10:00:00+05:30"), channel: "PHONE",
        items: [{ plan_item_id: p.sellItem, security_id: ctx.sec.X, action: "SELL", quantity_basis: "AMOUNT", advised_amount: 300000 }],
      }));
      await ctx.as("ops", (t) => recordExecution(t, ctx.users.ops, {
        adviceItemId: call.itemIds[0], executionDate: "2026-09-12", executedAmount: 250000, executedUnits: null, verificationType: "CLIENT_CONFIRMED",
      }));
      const [row] = await ctx.as("advisor", (t) => t<{ in_bank: string; money_left: string }[]>`
        select b.in_bank, c.money_left from public.v_client_bank b join public.v_client_cash c on c.client_id = b.client_id
        where b.client_id = ${p.clientId}`);
      // The sale is after the CAS of 01-Sep: the fund still holds those units, so the bank does not count it yet.
      expect(Number(row.money_left)).toBe(250000);
      expect(Number(row.in_bank)).toBe(0);
    });
  });
});
