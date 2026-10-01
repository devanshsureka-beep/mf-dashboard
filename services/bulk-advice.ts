/**
 * One call for many clients. Each client still gets their own advice batch
 * (own timestamp record, own ledger row), linked to their plan item for the
 * same fund and side when they have one; otherwise it is an off-plan call.
 */
import type { Actor, Tx } from "@/lib/db/tx";
import { AppError } from "@/lib/errors";
import { bulkAmount, type BulkMode } from "@/lib/domain/bulk-call";
import { issueAdvice } from "@/services/advice";
import { resolveFundRef } from "@/services/fund-search";
import type { Channel } from "@/types/domain";

export interface BulkSpec {
  clientIds: string[];
  fundRef: string;
  action: "BUY" | "SELL";
  mode: BulkMode;
  value: number;
}

export interface BulkLine {
  client_id: string;
  client_code: string;
  full_name: string;
  money_left: number;
  live_value: number;
  holding_value: number | null;
  amount: number | null;
  skip: string | null;
  plan_item_id: string | null;
  plan_yet_to_advise: number | null;
}

export const MAX_BULK_CLIENTS = 300;

/** Read-only: what each selected client would be told. */
export async function planBulkCall(tx: Tx, spec: BulkSpec, securityId: string | null): Promise<BulkLine[]> {
  if (!spec.clientIds.length) return [];
  if (spec.clientIds.length > MAX_BULK_CLIENTS) throw new AppError(`Select at most ${MAX_BULK_CLIENTS} clients at once.`);
  const rows = await tx<{ client_id: string; client_code: string; full_name: string; money_left: number; live_value: number }[]>`
    select client_id, client_code, full_name, money_left, coalesce(live_portfolio_value, 0) as live_value
    from public.v_client_summary where client_id = any(${spec.clientIds}::uuid[])
    order by full_name`;
  const holdings = securityId
    ? await tx<{ client_id: string; value: number }[]>`
        select client_id, sum(live_value) as value from public.v_holding_live
        where security_id = ${securityId} and client_id = any(${spec.clientIds}::uuid[]) group by client_id`
    : [];
  const side = spec.action === "SELL" ? "SELL" : "BUY";
  const items = securityId
    ? await tx<{ client_id: string; plan_item_id: string; yet_to_advise_amount: number }[]>`
        select distinct on (v.client_id) v.client_id, v.plan_item_id, v.yet_to_advise_amount
        from public.v_plan_item_progress v
        where v.plan_status = 'ACTIVE' and v.item_status <> 'CANCELLED' and v.side = ${side}
          and v.security_id = ${securityId} and v.client_id = any(${spec.clientIds}::uuid[])
        order by v.client_id, v.yet_to_advise_amount desc`
    : [];
  return rows.map((r) => {
    const holding = holdings.find((h) => h.client_id === r.client_id)?.value ?? null;
    const res = bulkAmount(spec.mode, spec.value, { money_left: r.money_left, live_value: r.live_value, holding_value: holding }, spec.action);
    const item = items.find((i) => i.client_id === r.client_id);
    return {
      ...r,
      holding_value: holding,
      amount: "amount" in res ? res.amount : null,
      skip: "skip" in res ? res.skip : null,
      plan_item_id: item?.plan_item_id ?? null,
      plan_yet_to_advise: item?.yet_to_advise_amount ?? null,
    };
  });
}

/** Existing security for a fund reference, without creating anything. */
export async function peekFundRef(tx: Tx, ref: string): Promise<string | null> {
  if (ref.startsWith("sec:")) return ref.slice(4);
  if (ref.startsWith("isin:")) {
    const r = await tx<{ id: string }[]>`select id from public.security_master where isin = ${ref.slice(5)}`;
    return r[0]?.id ?? null;
  }
  return null;
}

export async function issueBulkCall(
  tx: Tx,
  actor: Actor,
  spec: BulkSpec & { communicatedAt: Date; channel: Channel; notes: string | null },
): Promise<{ issued: (BulkLine & { batch_code: string })[]; skipped: BulkLine[] }> {
  const securityId = await resolveFundRef(tx, spec.fundRef, actor.id);
  const lines = await planBulkCall(tx, spec, securityId);
  if (lines.length !== new Set(spec.clientIds).size) throw new AppError("Some selected clients are not visible to you.", "FORBIDDEN");
  const issued: (BulkLine & { batch_code: string })[] = [];
  for (const l of lines) {
    if (l.amount == null) continue;
    const out = await issueAdvice(tx, actor, {
      clientId: l.client_id,
      communicatedAt: spec.communicatedAt,
      channel: spec.channel,
      notes: spec.notes,
      items: [{
        plan_item_id: l.plan_item_id,
        security_id: securityId,
        action: spec.action,
        quantity_basis: "AMOUNT",
        advised_amount: l.amount,
      }],
    });
    issued.push({ ...l, batch_code: out.batchCode });
  }
  if (!issued.length) throw new AppError("No call was recorded: every selected client was skipped.");
  return { issued, skipped: lines.filter((l) => l.amount == null) };
}
