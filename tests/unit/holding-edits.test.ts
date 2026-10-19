import { describe, expect, it } from "vitest";
import { holdingChanges } from "@/lib/domain/holding-edits";

describe("holdingChanges", () => {
  const base = [
    { holdingId: "a", name: "Fund A", folio: "111/1", units: 1000, nav: 10 },
    { holdingId: "b", name: "Fund B", folio: null, units: 50.5, nav: 200 },
    { holdingId: "c", name: "Fund C", folio: "333", units: 10, nav: 100 },
  ];

  it("finds edited units and folios, removed and added funds, with the value each moves", () => {
    const changes = holdingChanges(base, [
      { holdingId: "a", name: "Fund A", folio: "111/1", units: 1200, nav: 10 },
      { holdingId: "b", name: "Fund B", folio: "  ", units: 50.5, nav: 200 }, // a blank folio is no folio
      { holdingId: null, name: "Fund D", folio: null, units: 20, nav: 25 },
    ]);
    expect(changes.map((c) => [c.kind, c.name, c.delta])).toEqual([
      ["EDITED", "Fund A", 2000], ["REMOVED", "Fund C", -1000], ["ADDED", "Fund D", 500],
    ]);
    expect(changes[0].text).toMatch(/1,000\.000 → 1,200\.000 units/);
  });

  it("sees no change when units only differ beyond 4 decimals", () => {
    expect(holdingChanges(base, base.map((b) => ({ ...b, units: b.units + 0.00001 })))).toEqual([]);
  });

  it("reports a folio change without a value change", () => {
    const [c] = holdingChanges(base.slice(0, 1), [{ holdingId: "a", name: "Fund A", folio: "999", units: 1000, nav: 10 }]);
    expect(c).toMatchObject({ kind: "EDITED", delta: 0 });
    expect(c.text).toMatch(/folio 111\/1 → 999/);
  });
});
