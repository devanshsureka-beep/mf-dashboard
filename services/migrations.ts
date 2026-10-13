/**
 * Migrate to Direct (Regular -> Direct plan of the same fund). Plan lines are
 * Buy, Sell or Keep only (0023): a migration is a Sell of the Regular plan and a
 * Buy of the Direct plan, done as redeem + buy. No Next.js imports.
 */
import type { Actor, Tx } from "@/lib/db/tx";
import { setAuditReason } from "@/lib/db/tx";
import { detectPlanType, nameSimilarity } from "@/lib/domain/securities";
import { resolveOrCreateSecurity } from "./securities";

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

/** Keep lines of a Regular fund with a value whose note says Migrate to Direct. */
async function migrateNoteLines(tx: Tx, planId: string) {
  const rows = await tx<{ id: string; scheme_name: string; reason: string | null; current_amount: number | null; isin: string | null; plan_type: string | null; sec_name: string | null }[]>`
    select i.id, i.scheme_name, i.reason, i.current_amount::float8 as current_amount, sm.isin, sm.plan_type, sm.scheme_name as sec_name
    from public.advisory_plan_items i
    join public.advisory_plans p on p.id = i.plan_id and p.status in ('DRAFT', 'ACTIVE')
    left join public.security_master sm on sm.id = i.security_id
    where i.plan_id = ${planId} and i.action = 'RETAIN' and i.status = 'OPEN' and i.reason ~* 'migrate to direct'`;
  return rows.filter((r) => (r.plan_type ?? detectPlanType(r.sec_name ?? r.scheme_name)) !== "DIRECT" && (r.current_amount ?? 0) > 0);
}

/**
 * Plans read before migrations became Sell + Buy keep "Migrate to Direct" as a
 * note on a Keep line. Turn each such Regular holding into a Sell of its value
 * and a Buy of the Direct plan (from the AMFI list; a name-only fund when no
 * single match is clear). Audited.
 */
export async function convertMigrateNotes(tx: Tx, actor: Actor, planId: string): Promise<number> {
  const regular = await migrateNoteLines(tx, planId);
  if (!regular.length) return 0;
  await setAuditReason(tx, "Migrate to Direct notes turned into Sell (Regular) + Buy (Direct) lines");
  for (const r of regular) {
    const to = (await findDirectVariant(tx, r.isin, actor.id))
      ?? (await resolveOrCreateSecurity(tx, { scheme_name: directName(r.sec_name ?? r.scheme_name), plan_type: "DIRECT", amc: null }, actor.id));
    const toName = (await tx<{ scheme_name: string }[]>`select scheme_name from public.security_master where id = ${to}`)[0].scheme_name;
    await tx`
      insert into public.advisory_plan_items (plan_id, security_id, scheme_name, action, target_amount, reason, priority, status, created_by, tranche_plan_id)
      select plan_id, ${to}, ${toName}, 'BUY', ${r.current_amount}, 'Migrate to Direct: buy the Direct plan with the Regular redemption',
             coalesce(priority, 0) + 1, 'OPEN', ${actor.id}, tranche_plan_id
      from public.advisory_plan_items where id = ${r.id}`;
    await tx`
      update public.advisory_plan_items
      set action = 'SELL', target_amount = ${r.current_amount},
          reason = 'Migrate to Direct: redeem the Regular plan'
                   || coalesce('; ' || nullif(regexp_replace(coalesce(reason, ''), '^(Kept for now: )?(MIGRATE TO DIRECT;?[[:space:]]*)?', '', 'i'), ''), '')
      where id = ${r.id}`;
  }
  return regular.length;
}

/** Keep lines the convert button would turn into Sell + Buy (shown as a prompt). */
export async function countMigrateNotes(tx: Tx, planId: string): Promise<number> {
  return (await migrateNoteLines(tx, planId)).length;
}

/** "X Fund - Regular Plan - Growth" -> "X Fund - Direct Plan - Growth" (a name only). */
function directName(name: string): string {
  return /regular/i.test(name) ? name.replace(/regular/gi, "Direct") : `${name} - Direct Plan`;
}
