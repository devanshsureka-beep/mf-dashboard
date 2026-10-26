/**
 * Quarterly review wording shared by the on-page review and the PDF, so both read the same:
 * number formats and each page's running head, eyebrow and title (after the reference report).
 */
import { formatINR, formatINRCompact } from "@/lib/format";
import { dayMon } from "./quarterly";
import type { QuarterlyReport } from "./quarterly-report";

const minus = (t: string) => t.replace(/^-/, "−");
/** ₹6.88L */
export const L = (x: number) => minus(formatINRCompact(x));
/** ₹1,77,985 */
export const R = (x: number) => minus(formatINR(x));
/** +₹32,094 / −₹12,989 */
export const signed = (x: number, full = true) => `${x >= 0 ? "+" : "−"}${(full ? formatINR : formatINRCompact)(Math.abs(x))}`;
/** +1.4% / −5.5% */
export const pct = (x: number | null | undefined, d = 1) => (x == null ? "—" : `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(d)}%`);
/** 24.2% */
export const share = (x: number | null | undefined) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);
/** 12 Oct 2026 / 12 Oct */
export const date = (d: string, year = true) => dayMon(d, year);

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthOf = (d: string) => MONTHS[Number(d.slice(5, 7)) - 1];
const WORDS = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve"];

export interface PageHead { key: string; section: string; eyebrow: string; title: string }

/** Every page this client's review has, in the reference order, with its heads. */
export function pageHeads(r: QuarterlyReport): PageHead[] {
  const m = monthOf(r.windowStart);
  const months = Math.max(1, Math.round((Date.parse(`${r.windowEnd}T00:00:00Z`) - Date.parse(`${r.windowStart}T00:00:00Z`)) / (30.44 * 86_400_000)));
  const span = months <= 12 ? `${WORDS[months]} month${months === 1 ? "" : "s"}` : "This review";
  const pages: (PageHead | false)[] = [
    { key: "cover", section: "", eyebrow: "", title: "Cover" },
    { key: "glance", section: "Review at a glance", eyebrow: "Snapshot", title: "Review at a glance" },
    { key: "story", section: "The story so far", eyebrow: `${span} in one page`, title: "The story so far" },
    { key: "market", section: "Market context", eyebrow: "The backdrop", title: "What the market did" },
    r.plan.rows.length > 0 && { key: "plan", section: `The ${m} plan`, eyebrow: "What you did", title: `The ${m} plan — what went through` },
    r.score.rows.length > 0 && { key: "score", section: "New-money scorecard", eyebrow: "What you bought", title: `Every rupee since ${m} — fund by fund` },
    r.old != null && { key: "old", section: "Old vs new portfolio", eyebrow: "What the switch added", title: "Old portfolio vs new — what we achieved" },
    { key: "health", section: "Fund health check", eyebrow: "Every fund", title: `Fund health check at ${date(r.asOf, false)} NAVs` },
    r.rebalance != null && { key: "rebalance", section: "Rebalance", eyebrow: "One-time fix", title: `Rebalance — sell and buy, at ${date(r.asOf, false)} NAV` },
    { key: "structure", section: "Portfolio structure", eyebrow: "Where the money sits", title: r.structure.changes ? "Portfolio structure — now vs after" : "Portfolio structure" },
    r.sip.rows.length > 0 && { key: "sip", section: "SIP plan", eyebrow: "Keep the engine running", title: r.sip.fromNext ? `Your ${R(r.sip.fromNext)} monthly SIP` : "Your SIP plan" },
    { key: "tax", section: "Tax", eyebrow: r.rebalance?.sells.length ? "What the fix costs" : "What it costs", title: r.rebalance?.sells.length ? "Tax and cost of the rebalance" : `Tax and cost, ${r.tax.fy}` },
    { key: "projections", section: "Where this is heading", eyebrow: "Projections", title: "Where this is heading" },
    { key: "actions", section: "Next quarter", eyebrow: "What we do next", title: "Action plan" },
  ];
  return pages.filter((p): p is PageHead => p !== false);
}

export const RIA = "SEBI RIA INA000017639";
