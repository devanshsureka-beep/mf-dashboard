import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mapSellAction, normaliseVerdict, parseAdvisoryReportLines } from "@/lib/parsers/advisory-report";

const lines = readFileSync("tests/fixtures/univest-report.sample.txt", "utf8").split("\n");
const base = parseAdvisoryReportLines(lines);

describe("\"Full exit\" and other ways a report says sell everything", () => {
  it.each(["Full Exit", "FULL EXIT", "Complete exit", "100% Exit", "Exit fully", "Exit (Full)", "Sell all", "Stop SIP & Exit", "exit"])("%s is an exit", (w) => {
    expect(normaliseVerdict(w)).toMatch(/^EXIT\b/);
    expect(mapSellAction(w)).toBe("SELL");
  });

  it("\"Exit later\" stays a keep for now", () => {
    expect(normaliseVerdict("Full exit later")).toMatch(/^EXIT LATER/);
    expect(mapSellAction("Exit later")).toBe("RETAIN");
  });

  it("the review reads \"Full Exit\" exactly as \"EXIT\"", () => {
    const worded = parseAdvisoryReportLines(lines.map((l) => l.replace(/ \| EXIT \| /, " | Full Exit | ")));
    expect(worded.problems).toEqual([]);
    expect(worded.sells.map((s) => [s.fund, s.value])).toEqual(base.sells.map((s) => [s.fund, s.value]));
  });

  it("a fund the review fully exits but the sell table leaves out is added as a sell", () => {
    const changed = lines
      .filter((l) => !l.startsWith("PGIM India Flexi Cap Fund (Reg) | 9005 / 5 | Full exit"))
      .map((l) => (l.startsWith("PGIM India Flexi Cap Fund | ₹1,58,846") ? l.replace(" | EXIT | ", " | FULL EXIT | ") : l))
      .map((l) => (l.startsWith("Total to be redeemed (9 folios)") ? l.replace("₹15,77,656.82", "₹14,18,810.82") : l));
    const r = parseAdvisoryReportLines(changed);
    expect(r.problems).toEqual([]);
    expect(r.sells).toHaveLength(base.sells.length);
    expect(r.sells.find((s) => /PGIM/.test(s.fund))).toMatchObject({ value: 158846, partial: false, action: "SELL", planType: "REGULAR" });
    expect(r.sellTotal).toBe(base.sellTotal);
  });
});
