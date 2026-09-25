import type { Tx } from "@/lib/db/tx";
import { bestSecurityMatch, detectPlanType, type SecurityCandidate } from "@/lib/domain/securities";

export interface SecurityRow {
  id: string;
  isin: string | null;
  scheme_name: string;
  amc: string | null;
  category: string | null;
  plan_type: string | null;
  asset_class: string | null;
}

export async function searchSecurities(tx: Tx, q: string, limit = 20): Promise<SecurityRow[]> {
  const term = `%${q.trim()}%`;
  return tx<SecurityRow[]>`
    select id, isin, scheme_name, amc, category, plan_type, asset_class
    from public.security_master
    where is_active and (${q.trim() === ""} or scheme_name ilike ${term} or isin ilike ${term} or amc ilike ${term})
    order by scheme_name
    limit ${limit}
  `;
}

export async function listAllSecurities(tx: Tx): Promise<SecurityRow[]> {
  return tx<SecurityRow[]>`
    select id, isin, scheme_name, amc, category, plan_type, asset_class
    from public.security_master where is_active order by scheme_name
  `;
}

/**
 * Deterministic resolution for CAS holdings: ISIN is authoritative. Creates the
 * security_master row when the ISIN is new. ISIN-less lines resolve by exact
 * normalised name, else a new ISIN-less entry is created.
 */
export async function resolveOrCreateSecurity(
  tx: Tx,
  h: { isin?: string | null; scheme_name: string; amc?: string | null; category?: string | null; plan_type?: string | null },
  createdBy: string | null,
): Promise<string> {
  const planType = h.plan_type ?? detectPlanType(h.scheme_name);
  if (h.isin) {
    const existing = await tx<{ id: string }[]>`select id from public.security_master where isin = ${h.isin}`;
    if (existing[0]) return existing[0].id;
    // A fund recommended by name (advisory report, no ISIN) shows up in a CAS
    // for the first time: attach the ISIN to that entry so calls made against
    // it match the CAS transactions. Only on a confident, same-plan match.
    const isinLess = await tx<SecurityCandidate[]>`
      select id, scheme_name, isin, plan_type, aliases from public.security_master where isin is null and is_active`;
    const best = bestSecurityMatch(h.scheme_name, isinLess);
    if (best.confident && best.candidate && (!planType || !best.candidate.plan_type || best.candidate.plan_type === planType)) {
      await tx`
        update public.security_master
           set isin = ${h.isin}, plan_type = coalesce(plan_type, ${planType}), amc = coalesce(amc, ${h.amc ?? null}),
               aliases = case when ${h.scheme_name} = any(aliases) or scheme_name = ${h.scheme_name} then aliases
                              else array_append(aliases, ${h.scheme_name}) end
         where id = ${best.candidate.id} and isin is null`;
      return best.candidate.id;
    }
    const inserted = await tx<{ id: string }[]>`
      insert into public.security_master (isin, scheme_name, amc, category, plan_type, created_by)
      values (${h.isin}, ${h.scheme_name}, ${h.amc ?? null}, ${h.category ?? null}, ${planType}, ${createdBy})
      on conflict (isin) do update set updated_at = public.security_master.updated_at
      returning id`;
    return inserted[0].id;
  }
  const byName = await tx<{ id: string }[]>`
    select id from public.security_master
    where name_key = trim(regexp_replace(lower(${h.scheme_name}), '[^a-z0-9]+', ' ', 'g'))
    order by (isin is null) desc
    limit 1`;
  if (byName[0]) return byName[0].id;
  const inserted = await tx<{ id: string }[]>`
    insert into public.security_master (scheme_name, amc, category, plan_type, created_by)
    values (${h.scheme_name}, ${h.amc ?? null}, ${h.category ?? null}, ${planType}, ${createdBy})
    returning id`;
  return inserted[0].id;
}

export type SecurityInput = { isin?: string | null; scheme_name: string; amc?: string | null; category?: string | null; plan_type?: string | null };

/** Cache key used by the bulk resolver (ISIN, else normalised name). */
export const securityKey = (x: { isin?: string | null; scheme_name: string }) => x.isin ?? `name:${x.scheme_name.toLowerCase()}`;

/**
 * Same rules as resolveOrCreateSecurity, for a whole CAS at once: a handful of
 * queries instead of several per fund (matters when the database is far away).
 */
export async function resolveSecuritiesBulk(tx: Tx, inputs: SecurityInput[], createdBy: string | null): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = new Map<string, SecurityInput>();
  for (const x of inputs) if (!unique.has(securityKey(x))) unique.set(securityKey(x), x);

  const isins = [...unique.values()].map((x) => x.isin).filter((i): i is string => Boolean(i));
  if (isins.length) {
    const found = await tx<{ id: string; isin: string }[]>`select id, isin from public.security_master where isin = any(${isins}::text[])`;
    for (const f of found) out.set(f.isin, f.id);
  }

  const missing = [...unique.entries()].filter(([k]) => !out.has(k));
  const missingIsin = missing.filter(([, x]) => x.isin);
  if (missingIsin.length) {
    // Name-only entries (funds bought from a report) pick up their ISIN here.
    const isinLess = await tx<SecurityCandidate[]>`
      select id, scheme_name, isin, plan_type, aliases from public.security_master where isin is null and is_active`;
    const toInsert: { isin: string; scheme_name: string; amc: string | null; category: string | null; plan_type: string | null; created_by: string | null }[] = [];
    for (const [k, x] of missingIsin) {
      const planType = x.plan_type ?? detectPlanType(x.scheme_name);
      const best = bestSecurityMatch(x.scheme_name, isinLess);
      if (best.confident && best.candidate && (!planType || !best.candidate.plan_type || best.candidate.plan_type === planType)) {
        const cand = best.candidate;
        await tx`
          update public.security_master
             set isin = ${x.isin!}, plan_type = coalesce(plan_type, ${planType}), amc = coalesce(amc, ${x.amc ?? null}),
                 aliases = case when ${x.scheme_name} = any(aliases) or scheme_name = ${x.scheme_name} then aliases
                                else array_append(aliases, ${x.scheme_name}) end
           where id = ${cand.id} and isin is null`;
        out.set(k, cand.id);
        isinLess.splice(isinLess.indexOf(cand), 1);
      } else {
        toInsert.push({ isin: x.isin!, scheme_name: x.scheme_name, amc: x.amc ?? null, category: x.category ?? null, plan_type: planType, created_by: createdBy });
      }
    }
    if (toInsert.length) {
      const rows = await tx<{ id: string; isin: string }[]>`
        insert into public.security_master ${tx(toInsert)}
        on conflict (isin) do update set updated_at = public.security_master.updated_at
        returning id, isin`;
      for (const r of rows) out.set(r.isin, r.id);
    }
  }
  // ISIN-less lines are rare in a CAS: resolve them one by one.
  for (const [k, x] of missing.filter(([, x]) => !x.isin)) {
    out.set(k, await resolveOrCreateSecurity(tx, x, createdBy));
  }
  return out;
}

/**
 * Suggest a security for AI-extracted text. Only returns `confident: true`
 * for ISIN hits or unambiguous name matches; otherwise the plan item is
 * flagged needs_review for a person to resolve.
 */
export async function suggestSecurity(
  tx: Tx,
  name: string,
  isin: string | null | undefined,
  pool?: SecurityCandidate[],
): Promise<{ id: string | null; confident: boolean }> {
  if (isin) {
    const inPool = pool?.find((c) => c.isin === isin);
    if (inPool) return { id: inPool.id, confident: true };
    const hit = await tx<{ id: string }[]>`select id from public.security_master where isin = ${isin}`;
    if (hit[0]) return { id: hit[0].id, confident: true };
  }
  const candidates =
    pool ??
    (await tx<SecurityCandidate[]>`
      select id, scheme_name, isin, plan_type, aliases from public.security_master where is_active`);
  const best = bestSecurityMatch(name, candidates);
  return { id: best.candidate?.id ?? null, confident: best.confident };
}

export async function createSecurity(
  tx: Tx,
  input: { scheme_name: string; isin?: string | null; amc?: string | null; category?: string | null; plan_type?: string | null; asset_class?: string | null },
  createdBy: string,
): Promise<string> {
  const rows = await tx<{ id: string }[]>`
    insert into public.security_master (scheme_name, isin, amc, category, plan_type, asset_class, created_by)
    values (${input.scheme_name}, ${input.isin || null}, ${input.amc || null}, ${input.category || null},
            ${input.plan_type || detectPlanType(input.scheme_name)}, ${input.asset_class || null}, ${createdBy})
    returning id`;
  return rows[0].id;
}
