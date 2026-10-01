/**
 * Migrate to Direct: plan lines (action MIGRATE) that move a Regular holding to
 * the Direct plan of the same fund. Tracked as a checklist (v_migration_progress)
 * and executed through SWITCH calls linked to the line. Not part of the lump-sum
 * sell/buy targets. No Next.js imports.
 */
import type { Actor, Tx } from "@/lib/db/tx";
import { AppError } from "@/lib/errors";
import type { Channel } from "@/types/domain";
import { issueAdvice } from "./advice";

export type MigrationStatus = "TO_DO" | "CALL_ISSUED" | "DONE" | "DONE_IN_CAS" | "CANCELLED";

export interface MigrationRow {
  plan_item_id: string;
  plan_id: string;
  client_id: string;
  plan_status: string;
  security_id: string | null;
  scheme_name: string;
  folio_number: string | null;
  switch_to_security_id: string | null;
  switch_to_scheme_name: string | null;
  current_value: number;
  reason: string | null;
  advised_amount: number;
  executed_amount: number;
  open_calls: number;
  regular_units_now: number;
  direct_units_now: number;
  migration_status: MigrationStatus;
}

export async function getMigrations(tx: Tx, planId: string): Promise<MigrationRow[]> {
  return tx<MigrationRow[]>`
    select plan_item_id, plan_id, client_id, plan_status, security_id, scheme_name, folio_number,
           switch_to_security_id, switch_to_scheme_name, current_value::float8 as current_value, reason,
           advised_amount::float8 as advised_amount, executed_amount::float8 as executed_amount, open_calls,
           regular_units_now::float8 as regular_units_now, direct_units_now::float8 as direct_units_now, migration_status
    from public.v_migration_progress
    where plan_id = ${planId} and item_status <> 'CANCELLED'
    order by current_value desc`;
}

/**
 * One batch of SWITCH calls (Regular -> Direct), one per chosen line that still
 * has nothing open or done. All units of the Regular holding when the latest
 * CAS shows them, else the line's value.
 */
export async function issueMigrationCalls(
  tx: Tx,
  actor: Actor,
  args: { clientId: string; planId: string; planItemIds: string[]; channel: Channel; communicatedAt: Date; notes?: string | null },
): Promise<{ batchCode: string; count: number }> {
  const rows = (await getMigrations(tx, args.planId)).filter(
    (r) => r.client_id === args.clientId && args.planItemIds.includes(r.plan_item_id) && r.migration_status === "TO_DO",
  );
  if (rows.some((r) => r.plan_status !== "ACTIVE")) throw new AppError("Approve the plan before issuing migration calls.");
  if (!rows.length) throw new AppError("Nothing to issue: the chosen funds already have a call or are migrated.");
  const missing = rows.filter((r) => !r.security_id);
  if (missing.length) throw new AppError(`Pick the fund for ${missing.map((m) => m.scheme_name).join(", ")} first.`);
  const b = await issueAdvice(tx, actor, {
    clientId: args.clientId,
    communicatedAt: args.communicatedAt,
    channel: args.channel,
    notes: args.notes ?? "Migrate to Direct (Regular -> Direct plan of the same fund)",
    items: rows.map((r) => ({
      plan_item_id: r.plan_item_id,
      security_id: r.security_id as string,
      scheme_name: r.scheme_name,
      folio_number: r.folio_number,
      action: "SWITCH" as const,
      quantity_basis: r.regular_units_now > 0 ? ("UNITS" as const) : ("AMOUNT" as const),
      advised_units: r.regular_units_now > 0 ? r.regular_units_now : null,
      advised_amount: Math.round(r.current_value * 100) / 100,
    })),
  });
  return { batchCode: b.batchCode, count: rows.length };
}
