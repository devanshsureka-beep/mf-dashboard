import type { Actor, Tx } from "@/lib/db/tx";
import { setAuditReason } from "@/lib/db/tx";
import { AppError } from "@/lib/errors";
import { holdingChanges, roundUnits, type HoldingChange } from "@/lib/domain/holding-edits";
import { resolveFundRef } from "./fund-search";

export interface EditableHolding {
  holding_id: string;
  security_id: string | null;
  scheme_name: string;
  folio_number: string | null;
  units: number;
  nav: number | null;
  nav_date: string | null;
  category: string | null;
}

export interface EditableHoldings {
  snapshotId: string;
  snapshotDate: string;
  /** The holdings are already a correction (not a CAS). */
  isCorrection: boolean;
  today: string;
  rows: EditableHolding[];
}

/**
 * The client's current holdings (the latest confirmed snapshot) at today's NAV, for the editor.
 * Null before the first CAS (a new investor's empty start): the first CAS creates the holdings.
 */
export async function getEditableHoldings(tx: Tx, clientId: string): Promise<EditableHoldings | null> {
  const snap = (await tx<{ id: string; date: string; is_correction: boolean; placeholder: boolean; today: string }[]>`
    select s.id, s.snapshot_date::text as date, s.is_correction,
           (s.source = 'MANUAL' and s.holdings_count = 0 and not s.is_correction) as placeholder, app.today_ist()::text as today
    from public.v_latest_snapshot l join public.portfolio_snapshots s on s.id = l.snapshot_id
    where l.client_id = ${clientId}`)[0];
  if (!snap || snap.placeholder) return null;
  const rows = await tx<EditableHolding[]>`
    select h.holding_id, h.security_id, coalesce(sm.scheme_name, h.scheme_name) as scheme_name, h.folio_number,
           h.units::float8 as units, h.nav::float8 as nav, h.nav_date::text as nav_date,
           coalesce(m.category, sm.category) as category
    from public.v_holding_live h
    left join public.security_master sm on sm.id = h.security_id
    left join public.mf_schemes m on m.isin = h.isin
    where h.client_id = ${clientId} and h.snapshot_id = ${snap.id}
    order by h.live_value desc nulls last, h.scheme_name`;
  return { snapshotId: snap.id, snapshotDate: snap.date, isCorrection: snap.is_correction, today: snap.today, rows };
}

export interface HoldingCorrectionInput {
  clientId: string;
  /** The holdings the editor started from: refused if a CAS or another correction came in since. */
  baseSnapshotId: string;
  asOf: string;
  reason: string;
  /** Every holding after the edit: kept ones by holdingId, added ones by fund ("sec:<uuid>" / "isin:<ISIN>"). */
  rows: { holdingId: string | null; fundRef: string | null; folio: string | null; units: number }[];
}

/**
 * Save edited holdings as a new confirmed snapshot flagged as a correction (the CAS is never
 * touched). It becomes the client's latest holdings until a newer CAS replaces it.
 */
export async function saveHoldingCorrection(tx: Tx, actor: Actor, input: HoldingCorrectionInput): Promise<{ snapshotId: string; changes: HoldingChange[] }> {
  if (actor.role === "OPERATIONS") throw new AppError("Only an advisor or admin can edit holdings.", "FORBIDDEN");
  const reason = input.reason.trim();
  if (reason.length < 3) throw new AppError("Give a reason for the change: it is kept in History and the audit log.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.asOf)) throw new AppError("Choose the date the holdings are as of.");

  const current = await getEditableHoldings(tx, input.clientId);
  if (!current) throw new AppError("This client has no holdings yet: the first CAS creates them.");
  if (current.snapshotId !== input.baseSnapshotId) {
    throw new AppError("The holdings changed since you opened the editor (a new CAS or another correction). Reopen it and edit again.", "CONFLICT");
  }
  if (input.asOf > current.today) throw new AppError("The holdings date cannot be in the future.");
  if (input.asOf < current.snapshotDate) throw new AppError(`The holdings date cannot be before the current holdings (${current.snapshotDate}).`);

  const base = new Map(current.rows.map((r) => [r.holding_id, r]));
  const source = new Map((await tx<{ id: string; isin: string | null; amc: string | null; plan_type: string | null; category: string | null; cost_value: number | null }[]>`
    select id, isin, amc, plan_type, category, cost_value::float8 as cost_value from public.portfolio_holdings where snapshot_id = ${current.snapshotId}`).map((h) => [h.id, h]));

  type NewRow = {
    holdingId: string | null; security_id: string | null; scheme_name: string; amc: string | null; folio_number: string | null; isin: string | null;
    plan_type: string | null; category: string | null; units: number; cost_value: number | null; nav: number; nav_date: string | null;
  };
  const out: NewRow[] = [];
  const seenHolding = new Set<string>();
  for (const r of input.rows) {
    const units = roundUnits(Number(r.units));
    if (!Number.isFinite(units) || units <= 0) throw new AppError("Units must be more than 0 (remove the fund instead).");
    if (units > 1e12) throw new AppError("Units look wrong.");
    const folio = r.folio?.trim().slice(0, 40) || null;
    if (r.holdingId) {
      const b = base.get(r.holdingId);
      const s = source.get(r.holdingId);
      if (!b || !s) throw new AppError("A holding in the editor is no longer current. Reopen it and edit again.", "CONFLICT");
      if (seenHolding.has(r.holdingId)) throw new AppError(`${b.scheme_name} is listed twice.`);
      seenHolding.add(r.holdingId);
      if (b.nav == null) throw new AppError(`${b.scheme_name} has no NAV: it cannot be valued.`);
      out.push({
        holdingId: r.holdingId, security_id: b.security_id, scheme_name: b.scheme_name, amc: s.amc, folio_number: folio, isin: s.isin,
        plan_type: s.plan_type, category: s.category,
        units, cost_value: roundUnits(b.units) === units ? s.cost_value : null, nav: b.nav, nav_date: b.nav_date,
      });
      continue;
    }
    if (!r.fundRef) throw new AppError("Choose the fund for every added holding.");
    const securityId = await resolveFundRef(tx, r.fundRef, actor.id);
    const f = (await tx<{ scheme_name: string; isin: string | null; amc: string | null; plan_type: string | null; category: string | null; nav: number | null; nav_date: string | null }[]>`
      select sm.scheme_name, sm.isin, coalesce(m.amc, sm.amc) as amc, coalesce(m.plan_type, sm.plan_type) as plan_type,
             coalesce(m.category, sm.category) as category, m.nav::float8 as nav, m.nav_date::text as nav_date
      from public.security_master sm left join public.mf_schemes m on m.isin = sm.isin
      where sm.id = ${securityId}`)[0];
    if (!f) throw new AppError("Unknown fund.");
    if (f.nav == null) throw new AppError(`${f.scheme_name} has no NAV in the daily feed: it cannot be valued.`);
    out.push({
      holdingId: null, security_id: securityId, scheme_name: f.scheme_name, amc: f.amc, folio_number: folio, isin: f.isin,
      plan_type: f.plan_type, category: f.category, units, cost_value: null, nav: f.nav, nav_date: f.nav_date,
    });
  }

  // One line per fund and folio (as in a CAS).
  const keys = new Set<string>();
  for (const r of out) {
    const k = `${r.folio_number ?? ""}|${r.isin ?? r.scheme_name.toLowerCase()}`;
    if (keys.has(k)) throw new AppError(`${r.scheme_name}${r.folio_number ? ` (folio ${r.folio_number})` : ""} is listed twice: change the units of one line instead.`);
    keys.add(k);
  }

  const changes = holdingChanges(
    current.rows.map((b) => ({ holdingId: b.holding_id, name: b.scheme_name, folio: b.folio_number, units: b.units, nav: b.nav })),
    out.map((r) => ({ holdingId: r.holdingId, name: r.scheme_name, folio: r.folio_number, units: r.units, nav: r.nav })),
  );
  if (!changes.length) throw new AppError("Nothing changed.");

  const values = out.map((r) => Math.round(r.units * r.nav * 100) / 100);
  const total = Math.round(values.reduce((t, v) => t + v, 0) * 100) / 100;
  const invested = out.every((r) => r.cost_value != null) ? out.reduce((t, r) => t + (r.cost_value ?? 0), 0) : 0;
  await setAuditReason(tx, `Holdings corrected: ${reason}`);
  const snap = (await tx<{ id: string }[]>`
    insert into public.portfolio_snapshots
      (client_id, cas_document_id, snapshot_date, total_invested_value, total_current_value, source, extraction_method,
       holdings_count, created_by, is_correction, correction_of)
    values (${input.clientId}, null, ${input.asOf}::date, ${invested}, ${total}, 'MANUAL', 'MANUAL',
            ${out.length}, ${actor.id}, true, ${current.snapshotId})
    returning id`)[0];
  if (out.length) {
    await tx`insert into public.portfolio_holdings ${tx(out.map((r, i) => ({
      snapshot_id: snap.id, client_id: input.clientId, security_id: r.security_id, scheme_name: r.scheme_name, amc: r.amc,
      folio_number: r.folio_number, isin: r.isin, plan_type: r.plan_type, category: r.category, units: r.units,
      cost_value: r.cost_value, current_value: values[i], latest_nav: r.nav, latest_nav_date: r.nav_date ?? input.asOf,
    })))}`;
  }
  await tx`update public.portfolio_snapshots set review_status = 'CONFIRMED', review_note = ${reason} where id = ${snap.id}`;
  return { snapshotId: snap.id, changes };
}
