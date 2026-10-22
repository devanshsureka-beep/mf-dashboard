/**
 * The report check as one line per question: what the report says, what the newer CAS shows, the
 * issue in plain words and a possible fix, and the choice the line starts with (what the report
 * says, never a judgement of ours). Pure, so the screen and its tests agree.
 */
import type { ReportDiff } from "./report-plan";

export type CheckAction = "SELL" | "BUY" | "RETAIN";

export interface CheckQuestion {
  scheme_name: string;
  current_amount: number | null;
  reason: string | null;
  report_question: string;
  action: string;
  target_amount: number;
  report_diff: (ReportDiff & { done_answer?: { amount: number; date: string } }) | null;
}

export interface CheckLine {
  /** What the report says for the fund: its action and amount; null when it is not in the report. */
  report: { action: CheckAction | null; amount: number | null; words: string | null } | null;
  /** What the CAS shows, in a few words. */
  cas: string;
  issue: string;
  fix: string;
  /** The choice the line starts with. `action: null` = "Choose" (the report gives none). */
  start: { action: CheckAction | null; amount: number | null };
  /** Part already done (from the CAS), recorded with the answer when the choice is `doneFor`. */
  done: { amount: number; date: string; doneFor: CheckAction } | null;
}

const L = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1e7) return `₹${+(a / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `₹${+(a / 1e5).toFixed(2)}L`;
  if (a >= 1e3) return `₹${+(a / 1e3).toFixed(1)}K`;
  return `₹${Math.round(a)}`;
};
const day = (d: string | null) => {
  if (!d) return "";
  const [, m, dd] = d.split("-");
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1];
  return mon ? ` · ${dd}-${mon}` : ` · ${d}`;
};
/** Within 2% (or ₹500): the same amount, give or take NAV and rounding. */
const same = (a: number, b: number) => Math.abs(a - b) <= Math.max(500, Math.abs(b) * 0.02);

/** The report's own words for the fund, from the line's reason ("Report: Trim (no amount given)"). */
export function reportWords(reason: string | null): string | null {
  const w = reason?.replace(/^Report:\s*/, "").split(" → ")[0].trim();
  return w || null;
}

export function checkLine(q: CheckQuestion): CheckLine {
  const d = q.report_diff;
  const words = reportWords(q.reason);
  if (!d) {
    // The report's words could not be read as Buy, Sell or Keep.
    const amt = Number(q.target_amount) > 0 ? Number(q.target_amount) : null;
    return {
      report: { action: null, amount: amt, words },
      cas: Number(q.current_amount) > 0 ? `Holds ${L(Number(q.current_amount))}` : "Not held",
      issue: words ? `Report says "${words}": no clear action` : "No clear action in the report",
      fix: "choose Sell, Buy or Keep",
      start: { action: null, amount: amt },
      done: null,
    };
  }
  const A = d.report_amount ?? 0;
  const S = d.sold_since, B = d.bought_since;
  const date = day(d.done_date);
  const cas = S > 0 ? `Sold ${L(S)}${date}` : B > 0 ? `Bought ${L(B)}${date}` : d.cas_value > 0 ? `Holds ${L(d.cas_value)}` : "Not held";
  const done = d.done_amount > 0 && d.done_date && d.suggest !== "RETAIN" ? { amount: d.done_amount, date: d.done_date, doneFor: d.suggest } : null;
  const reportAs = (action: CheckAction) => ({ action, amount: A > 0 ? A : null, words });
  switch (d.kind) {
    case "SELL_GONE":
    case "SELL_CHANGED": {
      const r = reportAs("SELL");
      const start = { action: "SELL" as const, amount: A > 0 ? A : S > 0 ? S : null };
      if (S > 0 && A > 0 && !same(S, A) && S < A) return { report: r, cas, issue: `${L(A - S)} not sold yet`, fix: `count ${L(S)} as done`, start, done };
      if (S > 0) return { report: r, cas, issue: "Sold since the report", fix: "mark as done", start, done };
      if (d.kind === "SELL_GONE") return { report: r, cas, issue: "No longer in the CAS", fix: "check: sold elsewhere, or keep the sell", start, done };
      return { report: r, cas, issue: `Holding is now ${L(d.cas_value)}`, fix: "keep the sell as advised", start, done };
    }
    case "KEEP_GONE":
    case "KEEP_CHANGED": {
      const r = reportAs("RETAIN");
      const start = { action: "RETAIN" as const, amount: null };
      if (S > 0) return { report: r, cas, issue: `${L(S)} sold, not advised`, fix: "client's own sale", start, done };
      if (B > 0) return { report: r, cas, issue: `${L(B)} bought, not advised`, fix: "client's own buy", start, done };
      if (d.kind === "KEEP_GONE") return { report: r, cas, issue: "No longer in the CAS", fix: "client's own sale", start, done };
      return { report: r, cas, issue: "Only the value moved (NAV)", fix: "nothing to do", start, done };
    }
    case "BUY_HELD": {
      const r = reportAs("BUY");
      const start = { action: "BUY" as const, amount: A > 0 ? A : B > 0 ? B : null };
      if (B > 0 && A > 0 && !same(B, A) && B < A) return { report: r, cas, issue: `${L(A - B)} not bought yet`, fix: `count ${L(B)} as done`, start, done };
      if (B > 0) return { report: r, cas, issue: "Bought since the report", fix: "mark as done", start, done };
      return { report: r, cas, issue: "Already holds this fund", fix: "check: bought earlier, or buy as advised", start, done };
    }
    case "NOT_IN_REPORT":
      return { report: null, cas, issue: "Not in the report", fix: "client's own: leave as is", start: { action: "RETAIN", amount: null }, done };
    case "TRADED":
    default:
      return {
        report: null, cas,
        issue: S >= B ? `${L(S)} sold, not in the report` : `${L(B)} bought, not in the report`,
        fix: "ours (Sell/Buy) or client's own (Keep)?",
        start: { action: null, amount: S >= B ? S || null : B || null },
        done,
      };
  }
}

/** The note kept on the line when it is approved from the check (no typing needed). */
export function approvalNote(line: Pick<CheckLine, "issue" | "fix">, chosen: CheckAction): string {
  const as = chosen === "RETAIN" ? "Keep" : chosen === "SELL" ? "Sell" : "Buy";
  return `Approved in the report check (${as}): ${line.issue}; ${line.fix}.`;
}
