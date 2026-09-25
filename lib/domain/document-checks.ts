/**
 * Human-readable checklist for the "Check documents" page (pure).
 *
 * Groups the problems found by the report parser and the plan builder into
 * named checks, and states what was verified when a check passes, so a person
 * can see exactly why a pair of documents is (or is not) safe to onboard.
 */
import type { AdvisoryReportParse } from "@/lib/parsers/advisory-report";
import type { CasParseOutput } from "@/lib/parsers/cas";
import type { ReportPlanDraft } from "@/lib/domain/report-plan";

export type CheckId = "investor" | "statement" | "cas" | "sells" | "review" | "coverage" | "buys" | "sips" | "other";

export interface DocumentCheck {
  id: CheckId;
  label: string;
  /** PASS: verified. FAIL: blocks onboarding. WARN: onboarding allowed, the snapshot needs a manual check. */
  status: "PASS" | "FAIL" | "WARN";
  detail: string;
  problems: string[];
}

const LABELS: Record<CheckId, string> = {
  investor: "Same investor in both documents",
  statement: "Report made from this CAS (same valuation date)",
  cas: "CAS read completely (every folio, units × NAV, statement totals)",
  sells: "Sell list: every row read, totals match, tied to the CAS",
  review: "Sell / buy lists agree with the fund-wise review verdicts",
  coverage: "Every fund in the CAS is covered by the report, at the same value",
  buys: "Buy list: every row read, totals match",
  sips: "SIP changes: every row read, totals and routing panel match",
  other: "Other checks",
};

/** Which check a problem message belongs to (messages are produced by our own parsers). */
export function categorise(problem: string): CheckId {
  if (/^The CAS is for|PAN/.test(problem)) return "investor";
  if (/was made from a CAS valued/.test(problem)) return "statement";
  if (/not covered by the report|reviews .* not in the CAS|report values it at|report keeps|both sells it and keeps it|Held \/ deferred/.test(problem)) return "coverage";
  if (/\bSIP\b/.test(problem)) return "sips";
  if (/[Rr]eview|verdict/.test(problem)) return "review";
  if (/\b[Bb]uy\b|top-up/.test(problem)) return "buys";
  if (/[Ss]ell|redeemed|full exit|trims/.test(problem)) return "sells";
  return "other";
}

const inr = (n: number | null | undefined) => (n == null ? "—" : `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`);

export function documentChecks(args: {
  cas: CasParseOutput;
  report: AdvisoryReportParse;
  draft: ReportPlanDraft | null;
  /** Problems from onboardingProblems() (identity + report + CAS tie-out). */
  problems: string[];
}): DocumentCheck[] {
  const { cas, report, draft } = args;
  const byCheck = new Map<CheckId, string[]>();
  for (const p of args.problems) {
    const id = categorise(p);
    byCheck.set(id, [...(byCheck.get(id) ?? []), p]);
  }
  const sells = report.sells;
  const sips = report.sips;
  const holdings = cas.schemes.filter((s) => (s.closingUnits ?? 0) > 0.0005 && (!cas.investor.pan || !s.pan || s.pan === cas.investor.pan));
  const casTotal = holdings.reduce((t, s) => t + (s.marketValue ?? 0), 0);

  const passDetail: Record<CheckId, string> = {
    investor: `${cas.investor.name ?? "—"} (PAN ${cas.investor.pan ?? "—"}) in the CAS; ${report.clientName ?? "—"} in the report.`,
    statement: `Both valued on ${cas.valuationDate ?? "—"}.`,
    cas: `${holdings.length} funds, ${inr(Math.round(casTotal * 100) / 100)}; ${cas.schemes.reduce((t, s) => t + s.transactions.length, 0)} transactions.`,
    sells: `${sells.length} rows (${sells.filter((s) => s.partial).length} partial) = ${inr(report.sellTotal)}, same as the printed total; each tied to its CAS folio.`,
    review: report.review.length
      ? `${report.review.length} verdicts (${report.review.map((r) => r.verdict).filter(Boolean).join(", ")}) agree with the sell and buy lists.`
      : `This report layout has no verdict table; every row was checked against its printed TOTAL and against the CAS instead.`,
    coverage: report.review.length
      ? `All ${holdings.length} CAS funds have a verdict in the report, valued as in the CAS.`
      : `All ${holdings.length} CAS funds are sold, kept (${report.holds.length} with values checked) or named in the report's fund list.`,
    buys: `${report.buys.length} rows = ${inr(report.buyTotal)}, same as the printed total.`,
    sips: sips.length
      ? `${sips.filter((s) => s.change === "START").length} start, ${sips.filter((s) => s.change === "STOP").length} stop, ${sips.filter((s) => s.change === "CHANGE").length} change; new total ${inr(report.sipTotals.next)}/month and current ${inr(report.sipTotals.current)}/month match the report${report.sipRouting.length ? " and its routing panel" : ""}.`
      : "The report has no SIP changes.",
    other: "",
  };

  const checks: DocumentCheck[] = [];
  const order: CheckId[] = ["investor", "statement", "cas", "sells", "review", "coverage", "buys", "sips", "other"];
  for (const id of order) {
    const problems = byCheck.get(id) ?? [];
    if (id === "cas") {
      // CAS reading issues do not block the plan, but the snapshot then needs a person to confirm it.
      const w = cas.warnings;
      checks.push({
        id, label: LABELS[id],
        status: w.length ? "WARN" : "PASS",
        detail: w.length ? `${w.length} point(s) to confirm by hand after onboarding; the plan itself is not affected.` : passDetail.cas,
        problems: w,
      });
      continue;
    }
    if (id === "other" && problems.length === 0) continue;
    if (!draft && problems.length === 0 && id !== "investor") continue; // identity failed first: nothing else was checked
    checks.push({ id, label: LABELS[id], status: problems.length ? "FAIL" : "PASS", detail: problems.length ? "" : passDetail[id], problems });
  }
  return checks;
}
