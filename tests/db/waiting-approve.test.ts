import { afterAll, describe, expect, it } from "vitest";
import { issueAdvice } from "@/services/advice";
import { getCasInbox } from "@/services/cas-inbox";
import { getTranches } from "@/services/client-desk";
import { confirmSnapshot, createSnapshotFromParsed } from "@/services/portfolio";
import { runReconciliation } from "@/services/reconciliation";
import { approveLine, getApprovable, getApprovedVsCas, keepWaiting, undoApproval } from "@/services/waiting-approve";
import { clientWithActivePlan, parsed, scenario, sql, TEST_DB, type Ctx } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});

const TODAY = "2026-10-22";

async function bank(ctx: Ctx, clientId: string) {
  return (await ctx.tx<{ in_bank: number; in_bank_cas: number; approved_sold: number; approved_bought: number; approved_count: number }[]>`
    select in_bank::float8, in_bank_cas::float8, approved_sold::float8, approved_bought::float8, approved_count
    from public.v_client_bank where client_id = ${clientId}`)[0];
}

describeDb("Approve waiting", () => {
  it("approves many waiting calls before the CAS: money moves now, undo/revise/cancel work, the next CAS verifies the same trades", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx); // CAS of 01-Sep: X 10,000 units @150; plan SELL X ₹10L, BUY Y ₹6L
      const call = (planItem: string, sec: string, action: "SELL" | "BUY", amount: number) =>
        ctx.as("advisor", (t) => issueAdvice(t, ctx.users.advisor, {
          clientId: p.clientId, communicatedAt: new Date("2026-09-10T10:00:00+05:30"), channel: "PHONE",
          items: [{ plan_item_id: planItem, security_id: sec, action, quantity_basis: "AMOUNT", advised_amount: amount }],
        }));
      const sell = (await call(p.sellItem, ctx.sec.X, "SELL", 200000)).itemIds[0];
      const buy = (await call(p.buyItem, ctx.sec.Y, "BUY", 100000)).itemIds[0];
      await ctx.tx`select set_config('app.audit_reason', 'test SIP line', true)`;
      const sip = (await ctx.tx<{ id: string }[]>`
        insert into public.sip_plan_items (client_id, plan_id, security_id, scheme_name, action, new_amount, status, advised_at)
        values (${p.clientId}, ${p.planId}, ${ctx.sec.Y}, 'Y SIP', 'START', 10000, 'ADVISED', '2026-09-10T10:00:00+05:30') returning id`)[0].id;

      const list = await ctx.as("advisor", (t) => getApprovable(t, p.clientId));
      expect(list.calls.map((c) => c.advice_item_id).sort()).toEqual([sell, buy].sort());
      expect(list.sips.map((s) => s.id)).toEqual([sip]);
      expect(await bank(ctx, p.clientId)).toMatchObject({ in_bank: 0, approved_sold: 0, approved_bought: 0 });

      const approve = (line: Parameters<typeof approveLine>[3]) => ctx.as("advisor", (t) => approveLine(t, ctx.users.advisor, p.clientId, line, TODAY));
      expect(await ctx.expectError("advisor", (t) => approveLine(t, ctx.users.advisor, p.clientId, { kind: "CALL", id: sell, choice: "DONE", date: "2026-09-09" }, TODAY))).toMatch(/before the call/);
      expect(await approve({ kind: "CALL", id: sell, choice: "DONE", date: "2026-09-11" })).toBe("Done");
      expect(await approve({ kind: "CALL", id: buy, choice: "PART", amount: "60,000", date: "2026-09-12" })).toBe("Part done");
      expect(await approve({ kind: "SIP", id: sip, choice: "STARTED", date: "2026-09-12" })).toBe("SIP started");

      // Money moves now: sold ₹2L and bought ₹60k since the CAS, nothing in any CAS yet.
      expect(await bank(ctx, p.clientId)).toMatchObject({ in_bank: 140000, in_bank_cas: 0, approved_sold: 200000, approved_bought: 60000, approved_count: 2 });
      const ledger = (await ctx.as("advisor", (t) => getTranches(t, p.clientId))).ledger;
      expect(ledger.find((r) => r.id === sell)).toMatchObject({ status: "EXECUTED", approved: 200000 });
      expect(ledger.find((r) => r.id === buy)).toMatchObject({ status: "PARTIALLY_EXECUTED", approved: 60000, pending: 40000 });
      const after = await ctx.as("advisor", (t) => getApprovable(t, p.clientId));
      expect(after.calls.map((c) => c.advice_item_id)).toEqual([buy]);
      expect(after.approved.map((a) => a.kind).sort()).toEqual(["CALL", "CALL", "SIP"]);

      // Undo the part buy and the SIP: waiting again, the money goes back.
      const buyExec = after.approved.find((a) => a.advice_item_id === buy)!.id;
      await ctx.as("advisor", (t) => undoApproval(t, p.clientId, "CALL", buyExec));
      await ctx.as("advisor", (t) => undoApproval(t, p.clientId, "SIP", sip));
      expect(await bank(ctx, p.clientId)).toMatchObject({ in_bank: 200000, approved_bought: 0 });
      expect((await ctx.tx<{ status: string }[]>`select status from public.sip_plan_items where id = ${sip}`)[0].status).toBe("ADVISED");
      expect(await ctx.expectError("advisor", (t) => undoApproval(t, p.clientId, "CALL", buyExec))).toMatch(/already undone/);

      // Revise and cancel: another sell call revised to ₹40k (a new call replaces it), then that one cancelled.
      const extra = (await call(p.sellItem, ctx.sec.X, "SELL", 50000)).itemIds[0];
      expect(await approve({ kind: "CALL", id: extra, choice: "REVISE", amount: "40000", reason: "Client's choice" })).toBe("Revised");
      const revised = (await ctx.tx<{ id: string; advised_amount: number }[]>`
        select id, advised_amount::float8 from public.advice_items where revises_advice_item_id = ${extra}`)[0];
      expect(revised.advised_amount).toBe(40000);
      expect(await ctx.expectError("advisor", (t) => approveLine(t, ctx.users.advisor, p.clientId, { kind: "CALL", id: extra, choice: "DONE" }, TODAY))).toMatch(/no longer waiting/);
      expect(await ctx.expectError("advisor", (t) => approveLine(t, ctx.users.advisor, p.clientId, { kind: "CALL", id: revised.id, choice: "CANCEL", reason: " " }, TODAY))).toMatch(/reason/);
      expect(await approve({ kind: "CALL", id: revised.id, choice: "CANCEL", reason: "Client declined" })).toBe("Cancelled");
      expect((await ctx.tx<{ status: string }[]>`select status from public.advice_items where id = ${revised.id}`)[0].status).toBe("CANCELLED");

      // The SIP, started again (the next CAS shows its first instalment).
      expect(await approve({ kind: "SIP", id: sip, choice: "STARTED", date: "2026-09-15" })).toBe("SIP started");

      // The buy, done in full this time.
      expect(await approve({ kind: "CALL", id: buy, choice: "DONE", date: "2026-09-12" })).toBe("Done");
      expect(await bank(ctx, p.clientId)).toMatchObject({ in_bank: 100000, approved_sold: 200000, approved_bought: 100000 });

      // The next CAS shows the sell (not the buy): the same execution is verified, never counted twice.
      const x = (await ctx.tx<{ scheme_name: string; isin: string }[]>`select scheme_name, isin from public.security_master where id = ${ctx.sec.X}`)[0];
      const y = (await ctx.tx<{ scheme_name: string; isin: string }[]>`select scheme_name, isin from public.security_master where id = ${ctx.sec.Y}`)[0];
      const snap = await ctx.as("ops", async (t) => {
        const pr = parsed("2026-09-25", [{ security: ctx.sec.X, name: x.scheme_name, units: 8666.667, nav: 150 }, { security: ctx.sec.Y, name: y.scheme_name, units: 100, nav: 100 }],
          [{ date: "2026-09-11", type: "REDEMPTION", scheme_name: x.scheme_name, isin: x.isin, folio_number: "T1", amount: -200000, units: -1333.333, nav: 150, balance_units: 8666.667 },
           { date: "2026-09-20", type: "SIP", description: "SIP Purchase", scheme_name: y.scheme_name, isin: y.isin, folio_number: "T1", amount: 10000, units: 100, nav: 100, balance_units: 100 }]);
        pr.holdings[0].isin = x.isin;
        pr.holdings[1].isin = y.isin;
        const id = await createSnapshotFromParsed(t, { clientId: p.clientId, casDocumentId: null, parsed: pr, source: "CAS", createdBy: ctx.users.ops.id });
        await confirmSnapshot(t, id, "checked");
        return id;
      });
      const run = await ctx.as("ops", (t) => runReconciliation(t, ctx.users.ops, { clientId: p.clientId, currentSnapshotId: snap }));
      const ex = (await ctx.tx<{ n: number; verified: number }[]>`
        select count(*)::int as n, count(cas_verified_at)::int as verified from public.executions where advice_item_id = ${sell} and status in ('EXECUTED', 'PARTIAL')`)[0];
      expect(ex).toEqual({ n: 1, verified: 1 });
      // The SIP approved by hand is now confirmed by the CAS (no longer undoable, no longer "waiting for CAS").
      expect((await ctx.tx<{ status: string; notes: string }[]>`select status, notes from public.sip_plan_items where id = ${sip}`)[0])
        .toMatchObject({ status: "COMPLETED", notes: expect.stringMatching(/Verified from CAS/) });
      expect((await ctx.as("advisor", (t) => getApprovable(t, p.clientId))).approved.filter((a) => a.kind === "SIP")).toEqual([]);

      // The approved buy is not in this CAS: asked once in the inbox; "keep waiting" stops the question for this CAS.
      const inbox = await ctx.as("ops", (t) => getCasInbox(t));
      expect(inbox.approvedMissing.find((m) => m.client_id === p.clientId)).toMatchObject({ snapshot_date: "2026-09-25", trades: 1 });
      const vs = await ctx.as("ops", (t) => getApprovedVsCas(t, p.clientId, "2026-09-25", [run.runId]));
      expect(vs.map((v) => [v.action, v.result])).toEqual([["SELL", "VERIFIED"], ["BUY", "NOT_IN_CAS"]]);
      const missing = vs.find((v) => v.result === "NOT_IN_CAS")!;
      await ctx.as("advisor", (t) => keepWaiting(t, p.clientId, missing.execution_id, "2026-09-25"));
      // Kept waiting, the buy stays an approval (this CAS does not have it): the sale is CAS-confirmed now.
      expect(await bank(ctx, p.clientId)).toMatchObject({ in_bank_cas: 200000, approved_sold: 0, approved_bought: 100000, in_bank: 100000 });
      expect((await ctx.as("advisor", (t) => getApprovable(t, p.clientId))).approved.map((a) => a.advice_item_id)).toEqual([buy]);
      expect((await ctx.as("ops", (t) => getCasInbox(t))).approvedMissing.find((m) => m.client_id === p.clientId)).toBeUndefined();
      expect((await ctx.as("ops", (t) => getApprovedVsCas(t, p.clientId, "2026-09-25", [run.runId]))).map((v) => v.result)).toEqual(["VERIFIED"]);
    });
  });
});
