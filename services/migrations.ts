/**
 * Migrate to Direct: plan lines (action MIGRATE) that move a Regular holding to
 * the Direct plan of the same fund. Tracked as a checklist (v_migration_progress)
 * and executed through SWITCH calls linked to the line. Not part of the lump-sum
 * sell/buy targets. No Next.js imports.
 */
import type { Actor, Tx } from "@/lib/db/tx";
import { setAuditReason } from "@/lib/db/tx";
import { AppError } from "@/lib/errors";
import { detectPlanType, nameSimilarity } from "@/lib/domain/securities";
import { resolveOrCreateSecurity } from "./securities";
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

/**
 * The Direct plan of the same fund, from the AMFI list: same AMC, same option
 * (Growth / IDCW) and category, the closest name. Returns its security (created
 * from AMFI with its ISIN when needed), or null when no single clear match exists.
 */
export async function findDirectVariant(tx: Tx, regularIsin: string | null, createdBy: string | null): Promise<string | null> {
  if (!regularIsin) return null;
  const r = (await tx<{ scheme_name: string; amc: string | null; option_type: string | null; category: string | null; plan_type: string | null }[]>`
    select scheme_name, amc, option_type, category, plan_type from public.mf_schemes where isin = ${regularIsin}`)[0];
  if (!r || !r.amc || r.plan_type === "DIRECT") return null;
  const cands = await tx<{ isin: string; scheme_name: string; amc: string | null; category: string | null; plan_type: string | null }[]>`
    select isin, scheme_name, amc, category, plan_type from public.mf_schemes
    where amc = ${r.amc} and plan_type = 'DIRECT' and option_type is not distinct from ${r.option_type}
      and (${r.category}::text is null or category is not distinct from ${r.category})`;
  const scored = cands.map((c) => ({ c, s: nameSimilarity(r.scheme_name, c.scheme_name) })).sort((a, b) => b.s - a.s);
  const best = scored[0];
  if (!best || best.s < 0.8 || (scored[1] && scored[1].s === best.s)) return null;
  return resolveOrCreateSecurity(tx, { isin: best.c.isin, scheme_name: best.c.scheme_name, amc: best.c.amc, category: best.c.category, plan_type: "DIRECT" }, createdBy);
}

/**
 * Plans approved before the checklist existed keep "Migrate to Direct" as a note
 * on a Keep line. Turn those Regular holdings into MIGRATE lines (audited).
 */
export async function convertMigrateNotes(tx: Tx, actor: Actor, planId: string): Promise<number> {
  const rows = await tx<{ id: string; scheme_name: string; reason: string | null; current_amount: number | null; isin: string | null; plan_type: string | null; sec_name: string | null }[]>`
    select i.id, i.scheme_name, i.reason, i.current_amount::float8 as current_amount, sm.isin, sm.plan_type, sm.scheme_name as sec_name
    from public.advisory_plan_items i
    join public.advisory_plans p on p.id = i.plan_id and p.status in ('DRAFT', 'ACTIVE')
    left join public.security_master sm on sm.id = i.security_id
    where i.plan_id = ${planId} and i.action = 'RETAIN' and i.status = 'OPEN' and i.reason ~* 'migrate to direct'`;
  const regular = rows.filter((r) => (r.plan_type ?? detectPlanType(r.sec_name ?? r.scheme_name)) !== "DIRECT" && (r.current_amount ?? 0) > 0);
  if (!regular.length) return 0;
  await setAuditReason(tx, "Migrate to Direct notes turned into the migration checklist");
  for (const r of regular) {
    const to = await findDirectVariant(tx, r.isin, actor.id);
    await tx`
      update public.advisory_plan_items
      set action = 'MIGRATE', target_amount = ${r.current_amount}, switch_to_security_id = ${to},
          reason = regexp_replace(coalesce(reason, ''), '^Kept for now: ', '')
      where id = ${r.id}`;
  }
  return regular.length;
}

/** Keep lines whose note says Migrate to Direct (shown as a prompt to convert them). */
export async function countMigrateNotes(tx: Tx, planId: string): Promise<number> {
  const r = await tx<{ n: number }[]>`
    select count(*)::int as n from public.advisory_plan_items
    where plan_id = ${planId} and action = 'RETAIN' and status = 'OPEN' and reason ~* 'migrate to direct'`;
  return r[0].n;
}
