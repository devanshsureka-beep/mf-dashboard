import type { Actor, Tx } from "@/lib/db/tx";
import { setAuditReason } from "@/lib/db/tx";
import { AppError } from "@/lib/errors";
import { addPlanItem, addSipItem, cancelPlanItem } from "./plans";

/**
 * SIP alongside lump sums. A SIP line counts only what its instalments have
 * actually invested (seen in CAS since it was advised), never a projection.
 * Last-moment changes move money between the two: a lump-sum buy becomes a
 * SIP (the advisor enters the monthly amount), or a SIP becomes a lump sum.
 */

export interface SipProgressRow {
  sip_item_id: string;
  plan_id: string;
  security_id: string | null;
  scheme_name: string;
  action: "START" | "STOP" | "CHANGE";
  item_status: "PLANNED" | "ADVISED" | "COMPLETED" | "CANCELLED";
  monthly_amount: number;
  invested_amount: number;
  instalments: number;
  last_instalment_date: string | null;
}

export interface ClientSip {
  sip_monthly_target: number;
  sip_monthly_advised: number;
  sip_monthly_started: number;
  sip_monthly_yet_to_advise: number;
  sip_invested: number;
  sips_to_stop: number;
  sips_stopped: number;
  lumpsum_buy_executed: number;
  total_invested_under_plan: number;
}

const NUM = ["sip_monthly_target", "sip_monthly_advised", "sip_monthly_started", "sip_monthly_yet_to_advise", "sip_invested",
  "sips_to_stop", "sips_stopped", "lumpsum_buy_executed", "total_invested_under_plan"] as const;

export async function getClientSip(tx: Tx, clientId: string): Promise<ClientSip> {
  const r = (await tx<Record<string, unknown>[]>`select * from public.v_client_sip where client_id = ${clientId}`)[0] ?? {};
  return Object.fromEntries(NUM.map((k) => [k, Number(r[k] ?? 0)])) as unknown as ClientSip;
}

export async function getSipProgress(tx: Tx, planId: string): Promise<SipProgressRow[]> {
  const rows = await tx<SipProgressRow[]>`
    select sip_item_id, plan_id, security_id, scheme_name, action, item_status, monthly_amount, invested_amount,
           instalments::int as instalments, last_instalment_date::text as last_instalment_date
    from public.v_sip_item_progress where plan_id = ${planId}`;
  return rows.map((r) => ({ ...r, monthly_amount: Number(r.monthly_amount), invested_amount: Number(r.invested_amount) }));
}

/** Change a SIP line's amounts on an approved plan (with a reason). */
export async function updateSipAmounts(
  tx: Tx, sipId: string, s: { oldAmount: number | null; newAmount: number | null; debitDay: number | null }, reason: string,
): Promise<void> {
  if (!reason.trim()) throw new AppError("A reason is required to change a SIP line.");
  const cur = (await tx<{ action: string; status: string }[]>`select action, status from public.sip_plan_items where id = ${sipId}`)[0];
  if (!cur) throw new AppError("SIP line not found.", "NOT_FOUND");
  if (cur.status === "CANCELLED") throw new AppError("This SIP line is cancelled.");
  if (cur.action !== "STOP" && !(Number(s.newAmount) > 0)) throw new AppError("Enter the SIP amount.");
  await setAuditReason(tx, reason);
  await tx`
    update public.sip_plan_items set old_amount = ${s.oldAmount}, new_amount = ${s.newAmount}, debit_day = ${s.debitDay}
    where id = ${sipId}`;
}

/**
 * A lump-sum buy line becomes a SIP. The part not yet advised (or the amount
 * given) leaves the lump-sum target; a SIP START line with the monthly amount
 * the advisor enters is added for the same fund.
 */
export async function convertBuyToSip(
  tx: Tx, actor: Actor, planItemId: string,
  c: { monthlyAmount: number; lumpsumAmount?: number | null; debitDay?: number | null; reason: string },
): Promise<{ sipItemId: string }> {
  const reason = c.reason.trim();
  if (!reason) throw new AppError("A reason is required.");
  if (!(c.monthlyAmount > 0)) throw new AppError("Enter the monthly SIP amount.");
  const it = (await tx<{ plan_id: string; plan_status: string; action: string; item_status: string; security_id: string | null;
    scheme_name: string; folio_number: string | null; target_amount: number; effective_advised: number; yet_to_advise_amount: number }[]>`
    select v.plan_id, v.plan_status, v.action, v.item_status, v.security_id, v.scheme_name, v.folio_number,
           v.original_target_amount::float8 as target_amount, v.advised_amount::float8 as effective_advised,
           v.yet_to_advise_amount::float8 as yet_to_advise_amount
    from public.v_plan_item_progress v where v.plan_item_id = ${planItemId}`)[0];
  if (!it) throw new AppError("Plan line not found.", "NOT_FOUND");
  if (it.action !== "BUY" || it.item_status !== "OPEN") throw new AppError("Only an open lump-sum BUY line can become a SIP.");
  if (!["DRAFT", "ACTIVE"].includes(it.plan_status)) throw new AppError(`The plan is ${it.plan_status.toLowerCase()}.`);
  const move = c.lumpsumAmount == null ? it.yet_to_advise_amount : Number(c.lumpsumAmount);
  if (!(move > 0)) throw new AppError("Nothing is left to advise on this line; it cannot move to SIP.");
  if (move > it.yet_to_advise_amount + 1) {
    throw new AppError(`Only ₹${Math.round(it.yet_to_advise_amount).toLocaleString("en-IN")} of this line is not yet advised.`);
  }

  await setAuditReason(tx, `Lump sum → SIP: ${reason}`);
  const remaining = Math.round((it.target_amount - move) * 100) / 100;
  if (remaining <= 0.5 && it.effective_advised <= 0.5) {
    await cancelPlanItem(tx, planItemId, `Moved to SIP: ${reason}`);
  } else {
    await tx`update public.advisory_plan_items set target_amount = ${Math.max(remaining, 0)} where id = ${planItemId}`;
  }
  const sipItemId = await addSipItem(tx, actor, it.plan_id, {
    security_id: it.security_id, scheme_name: it.scheme_name, folio_number: it.folio_number, action: "START",
    new_amount: c.monthlyAmount, debit_day: c.debitDay ?? null,
    notes: `Converted from lump sum ₹${Math.round(move).toLocaleString("en-IN")}: ${reason}`,
  }, `Lump sum → SIP: ${reason}`);
  return { sipItemId };
}

/** A SIP START/CHANGE line becomes a lump-sum buy of the amount the advisor enters. */
export async function convertSipToLumpsum(
  tx: Tx, actor: Actor, sipId: string, c: { lumpsumAmount: number; reason: string },
): Promise<{ planItemId: string }> {
  const reason = c.reason.trim();
  if (!reason) throw new AppError("A reason is required.");
  if (!(c.lumpsumAmount > 0)) throw new AppError("Enter the lump-sum amount.");
  const s = (await tx<{ plan_id: string; action: string; status: string; security_id: string | null; scheme_name: string; folio_number: string | null; plan_status: string }[]>`
    select s.plan_id, s.action, s.status, s.security_id, s.scheme_name, s.folio_number, p.status as plan_status
    from public.sip_plan_items s join public.advisory_plans p on p.id = s.plan_id where s.id = ${sipId}`)[0];
  if (!s) throw new AppError("SIP line not found.", "NOT_FOUND");
  if (s.action === "STOP" || !["PLANNED", "ADVISED"].includes(s.status)) {
    throw new AppError("Only a SIP start or change that has not started yet can become a lump sum.");
  }
  if (!s.security_id) throw new AppError("Pick the fund for this SIP line first.");

  await setAuditReason(tx, `SIP → lump sum: ${reason}`);
  await tx`
    update public.sip_plan_items set status = 'CANCELLED', notes = coalesce(notes || E'\\n', '') || ${`Moved to lump sum ₹${Math.round(c.lumpsumAmount).toLocaleString("en-IN")}: ${reason}`}
    where id = ${sipId}`;
  const planItemId = await addPlanItem(tx, actor, s.plan_id, {
    security_id: s.security_id, scheme_name: s.scheme_name, folio_number: s.folio_number, action: "BUY",
    target_amount: c.lumpsumAmount, reason: `Converted from SIP: ${reason}`,
  }, `SIP → lump sum: ${reason}`);
  return { planItemId };
}
