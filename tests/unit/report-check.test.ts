import { describe, expect, it } from "vitest";
import { approvalNote, checkLine, type CheckQuestion } from "@/lib/domain/report-check";

const q = (diff: CheckQuestion["report_diff"], extra: Partial<CheckQuestion> = {}): CheckQuestion => ({
  scheme_name: "Fund", current_amount: 100000, reason: "Report: Trim", report_question: "?", action: "RETAIN", target_amount: 0, report_diff: diff, ...extra,
});
const d = (o: Partial<NonNullable<CheckQuestion["report_diff"]>>) => ({
  kind: "SELL_CHANGED" as const, report_amount: 100000, cas_value: 60000, sold_since: 0, bought_since: 0, suggest: "SELL" as const, done_amount: 0, done_date: null, ...o,
});

describe("checkLine", () => {
  it("a sell partly done: report Sell ₹1L, ₹40K sold → ₹60K left, count ₹40K as done", () => {
    const l = checkLine(q(d({ sold_since: 40000, done_amount: 40000, done_date: "2026-10-02" })));
    expect(l.report).toMatchObject({ action: "SELL", amount: 100000 });
    expect(l.cas).toBe("Sold ₹40K · 02-Oct");
    expect([l.issue, l.fix]).toEqual(["₹60K not sold yet", "count ₹40K as done"]);
    expect(l.start).toEqual({ action: "SELL", amount: 100000 });
    expect(l.done).toEqual({ amount: 40000, date: "2026-10-02", doneFor: "SELL" });
  });

  it("a sell done in full is marked as done", () => {
    const l = checkLine(q(d({ kind: "SELL_GONE", sold_since: 99500, cas_value: 0, done_amount: 99500, done_date: "2026-09-25" })));
    expect([l.issue, l.fix]).toEqual(["Sold since the report", "mark as done"]);
  });

  it("a keep that was sold is the client's own sale, and starts as Keep", () => {
    const l = checkLine(q(d({ kind: "KEEP_CHANGED", report_amount: 310000, sold_since: 45000, suggest: "RETAIN" })));
    expect(l.report).toMatchObject({ action: "RETAIN" });
    expect([l.issue, l.fix]).toEqual(["₹45K sold, not advised", "client's own sale"]);
    expect(l.start.action).toBe("RETAIN");
    expect(l.done).toBeNull();
  });

  it("a buy partly done", () => {
    const l = checkLine(q(d({ kind: "BUY_HELD", report_amount: 200000, bought_since: 100000, suggest: "BUY", done_amount: 100000, done_date: "2026-10-15" })));
    expect([l.issue, l.fix]).toEqual(["₹1L not bought yet", "count ₹1L as done"]);
    expect(l.start).toEqual({ action: "BUY", amount: 200000 });
  });

  it("a fund not in the report is the client's own; a trade not in the report asks", () => {
    expect(checkLine(q(d({ kind: "NOT_IN_REPORT", report_amount: null, cas_value: 25472, suggest: "RETAIN" })))).toMatchObject({
      report: null, cas: "Holds ₹25.5K", issue: "Not in the report", start: { action: "RETAIN" },
    });
    expect(checkLine(q(d({ kind: "TRADED", report_amount: null, sold_since: 150000, done_amount: 150000, done_date: "2026-10-14" }))).start.action).toBeNull();
  });

  it("report words that could not be read: no choice made for you", () => {
    const l = checkLine(q(null, { reason: "Report: Rebalance towards target" }));
    expect(l.report).toEqual({ action: null, amount: null, words: "Rebalance towards target" });
    expect(l.start.action).toBeNull();
    expect(approvalNote(l, "RETAIN")).toMatch(/^Approved in the report check \(Keep\): /);
  });
});
