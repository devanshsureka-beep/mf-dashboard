/**
 * Edit holdings: what changed between the holdings the editor started from and the ones it saves.
 * Pure, so the editor's summary and the server's check agree.
 */
export interface BaseHolding { holdingId: string; name: string; folio: string | null; units: number; nav: number | null }
export interface EditedHolding { holdingId: string | null; name: string; folio: string | null; units: number; nav: number | null }

export interface HoldingChange { kind: "EDITED" | "ADDED" | "REMOVED"; name: string; text: string; delta: number }

export const roundUnits = (u: number) => Math.round(u * 10000) / 10000;
const sameFolio = (a: string | null, b: string | null) => (a?.trim() || null) === (b?.trim() || null);
const fmtUnits = (u: number) => u.toLocaleString("en-IN", { maximumFractionDigits: 4, minimumFractionDigits: 3 });
const value = (units: number, nav: number | null) => Math.round(units * (nav ?? 0) * 100) / 100;

/** Edited, added and removed holdings, with the change in value each makes (at the NAV shown). */
export function holdingChanges(base: readonly BaseHolding[], edited: readonly EditedHolding[]): HoldingChange[] {
  const out: HoldingChange[] = [];
  const kept = new Map(edited.filter((e) => e.holdingId).map((e) => [e.holdingId!, e]));
  for (const b of base) {
    const e = kept.get(b.holdingId);
    if (!e) {
      out.push({ kind: "REMOVED", name: b.name, text: `${b.name} removed`, delta: -value(b.units, b.nav) });
      continue;
    }
    const unitsChanged = roundUnits(e.units) !== roundUnits(b.units);
    const folioChanged = !sameFolio(e.folio, b.folio);
    if (!unitsChanged && !folioChanged) continue;
    const parts = [
      unitsChanged ? `${fmtUnits(b.units)} → ${fmtUnits(e.units)} units` : null,
      folioChanged ? `folio ${b.folio?.trim() || "—"} → ${e.folio?.trim() || "—"}` : null,
    ].filter(Boolean);
    out.push({ kind: "EDITED", name: b.name, text: `${b.name}: ${parts.join(", ")}`, delta: value(e.units, e.nav ?? b.nav) - value(b.units, b.nav) });
  }
  for (const e of edited) {
    if (e.holdingId) continue;
    out.push({ kind: "ADDED", name: e.name, text: `${e.name} added, ${fmtUnits(e.units)} units`, delta: value(e.units, e.nav) });
  }
  return out;
}
