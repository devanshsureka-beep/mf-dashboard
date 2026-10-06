import { afterAll, describe, expect, it } from "vitest";
import { issueAdvice } from "@/services/advice";
import {
  addAgreement, addPayment, getPremium, getReportNotes, getTimeline, listPayments, refundPayment, saveReportNotes, setAgreementStatus,
} from "@/services/client-record";
import { listDeskClients } from "@/services/clients";
import { clientWithActivePlan, scenario, sql, TEST_DB } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});

describeDb("Client record: agreements, premium, report notes, timeline", () => {
  it("records agreements and premium payments, keeps them for audit, and shows everything on one timeline", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx);
      let prem = await ctx.as("advisor", (t) => getPremium(t, p.clientId));
      expect(prem).toMatchObject({ premium_status: "UNPAID", premium_paid_total: 0, agreement_status: "NONE" });

      const ag = await ctx.as("ops", (t) => addAgreement(t, ctx.users.ops, p.clientId, {
        agreementType: "ADVISORY_AGREEMENT", title: "MF Premium advisory agreement", signedOn: "2026-09-01", validFrom: "2026-09-01", validTo: "2099-12-31",
      }));
      await ctx.as("ops", (t) => addPayment(t, ctx.users.ops, p.clientId, {
        amount: 50000, paidOn: "2026-09-01", periodFrom: "2026-09-01", periodTo: "2099-12-31", mode: "UPI", reference: "UTR123",
      }));
      prem = await ctx.as("advisor", (t) => getPremium(t, p.clientId));
      expect(prem).toMatchObject({ premium_status: "ACTIVE", premium_paid_total: 50000, paid_until: "2099-12-31", agreement_status: "VALID", agreements_signed: 1 });

      // A payment's amount cannot be changed or the row deleted, except an admin refund with a reason.
      const pay = (await ctx.as("ops", (t) => listPayments(t, p.clientId)))[0];
      expect(await ctx.expectError("ops", (t) => t`update public.client_payments set amount = 1 where id = ${pay.id}`)).toMatch(/immutable/);
      expect(await ctx.expectError("advisor", (t) => t`delete from public.client_payments where id = ${pay.id}`)).toMatch(/permission denied|cannot be deleted/);
      await expect(ctx.as("ops", (t) => refundPayment(t, ctx.users.ops, pay.id, "x"))).rejects.toThrow(/Only an admin/);
      await ctx.as("admin", (t) => refundPayment(t, ctx.users.admin, pay.id, "client cancelled within cooling-off"));
      prem = await ctx.as("advisor", (t) => getPremium(t, p.clientId));
      expect(prem.premium_paid_total).toBe(0);

      await ctx.as("advisor", (t) => setAgreementStatus(t, ag, "TERMINATED", "service ended"));
      prem = await ctx.as("advisor", (t) => getPremium(t, p.clientId));
      expect(prem.agreement_status).toBe("NONE");

      await ctx.as("advisor", (t) => saveReportNotes(t, ctx.users.advisor, p.clientId, "2026-09-01", { summary: "Exit done", outlook: "Hold", actions: "Review in Dec" }));
      await ctx.as("advisor", (t) => saveReportNotes(t, ctx.users.advisor, p.clientId, "2026-09-01", { summary: "Exit done (updated)", outlook: "Hold", actions: null }));
      expect(await ctx.as("advisor", (t) => getReportNotes(t, p.clientId, "2026-09-01"))).toMatchObject({ summary: "Exit done (updated)", actions: null });
      // Operations cannot write the advisor's report notes.
      expect(await ctx.expectError("ops", (t) => saveReportNotes(t, ctx.users.ops, p.clientId, "2026-10-01", { summary: "x", outlook: null, actions: null }))).toMatch(/row-level security/);

      await ctx.as("advisor", (t) => issueAdvice(t, ctx.users.advisor, {
        clientId: p.clientId, communicatedAt: new Date("2026-09-10T10:00:00+05:30"), channel: "PHONE",
        items: [{ plan_item_id: p.sellItem, security_id: ctx.sec.X, action: "SELL", quantity_basis: "AMOUNT", advised_amount: 100000 }],
      }));
      const tl = await ctx.as("advisor", (t) => getTimeline(t, p.clientId));
      const kinds = new Set(tl.map((e) => e.kind));
      for (const k of ["ONBOARDING", "CAS", "PLAN", "CALL", "AGREEMENT", "PAYMENT"]) expect(kinds).toContain(k);
      expect(tl.find((e) => e.kind === "CALL")).toMatchObject({ amount: 100000 });
      const onlyCalls = await ctx.as("advisor", (t) => getTimeline(t, p.clientId, { kinds: ["CALL"] }));
      expect(onlyCalls.every((e) => e.kind === "CALL")).toBe(true);
    });
  });

  it("the client list filters by premium, agreement, plan and attention", async () => {
    await scenario(async (ctx) => {
      const p = await clientWithActivePlan(ctx);
      const mine = async (f: Parameters<typeof listDeskClients>[1]) =>
        (await ctx.as("advisor", (t) => listDeskClients(t, f))).filter((c) => c.client_id === p.clientId).length;
      expect(await mine({ premium: "unpaid" })).toBe(1);
      expect(await mine({ agreement: "missing" })).toBe(1);
      expect(await mine({ plan: "active" })).toBe(1);
      expect(await mine({ plan: "none" })).toBe(0);
      const day = (d: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(Date.now() + d * 86_400_000));
      await ctx.as("ops", (t) => addPayment(t, ctx.users.ops, p.clientId, {
        amount: 25000, paidOn: day(-20), periodFrom: day(-20), periodTo: day(10), mode: "NEFT",
      }));
      expect(await mine({ premium: "renewal_due" })).toBe(1);
      expect(await mine({ premium: "unpaid" })).toBe(0);
      const row = (await ctx.as("advisor", (t) => listDeskClients(t, { q: "Test Client", sort: "value" }))).find((c) => c.client_id === p.clientId)!;
      expect(row).toMatchObject({ premium_paid_total: 25000, premium_status: "ACTIVE", renewal_due: true, agreement_status: "NONE" });
    });
  });
});
