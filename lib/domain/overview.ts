/**
 * Overview (the manager's view): the period it covers, each client's status and next action in the
 * client book, and the proof tag of each trade in the transaction log. Pure, so the page, the CSV
 * export and the tests agree.
 */

export const PERIODS = [
  { key: "month", label: "This month", months: 1 },
  { key: "3m", label: "Last 3 months", months: 3 },
  { key: "6m", label: "Last 6 months", months: 6 },
  { key: "12m", label: "Last 12 months", months: 12 },
] as const;
export type PeriodKey = (typeof PERIODS)[number]["key"];

export function periodOf(key: string | null | undefined): (typeof PERIODS)[number] {
  return PERIODS.find((p) => p.key === key) ?? PERIODS[0];
}

/** First day of the period's first month, and today (both YYYY-MM-DD, IST calendar). */
export function periodRange(key: string | null | undefined, today: string): { from: string; to: string; months: number } {
  const p = periodOf(key);
  const [y, m] = today.split("-").map(Number);
  const idx = y * 12 + (m - 1) - (p.months - 1);
  const fy = Math.floor(idx / 12);
  const fm = (idx % 12) + 1;
  return { from: `${fy}-${String(fm).padStart(2, "0")}-01`, to: today, months: p.months };
}

export interface BookClient {
  has_plan: boolean;
  has_draft: boolean;
  draft_days: number | null;
  pending: number;
  executed: number;
  left_to_advise: number;
  open_calls: number;
  /** Age in days of the client's oldest waiting call, and whether a CAS came after it. */
  oldest_wait_days: number | null;
  cas_after_oldest: boolean;
  cas_to_check: number;
  trades_to_decide: number;
  in_bank: number;
  buy_left: number;
  follow_ups: number;
}

export type BookStatus = { label: string; tone: "red" | "amber" | "orange" | "indigo" | "green" | "grey"; rank: number };

/** Behind = a call waiting more than 30 days. Rank: lower comes first in "Behind first". */
export function clientStatus(c: BookClient): BookStatus {
  if (c.pending >= 0.5 && (c.oldest_wait_days ?? 0) > 30) return { label: `Behind · ${c.oldest_wait_days} days`, tone: "red", rank: 0 };
  if (c.pending >= 0.5) return c.executed >= 0.5 ? { label: "Part done", tone: "amber", rank: 1 } : { label: "Waiting", tone: "orange", rank: 2 };
  // Calls can wait on a client with no active plan (advised outside a plan): those come first.
  if (!c.has_plan) return c.has_draft ? { label: "Draft", tone: "indigo", rank: 3 } : { label: "No plan", tone: "grey", rank: 6 };
  if (c.left_to_advise >= 0.5) return { label: "Next tranche", tone: "indigo", rank: 4 };
  return { label: "Done", tone: "green", rank: 5 };
}

const L = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1e7) return `₹${+(a / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `₹${+(a / 1e5).toFixed(1)}L`;
  if (a >= 1e3) return `₹${+(a / 1e3).toFixed(1)}K`;
  return `₹${Math.round(a)}`;
};

/** The one next step for the client, in the desk's order (the CAS first: it decides what is left). */
export function nextAction(c: BookClient): string {
  if (c.cas_to_check) return "Check the new CAS";
  if (c.trades_to_decide) return `Decide ${c.trades_to_decide} trade${c.trades_to_decide === 1 ? "" : "s"} in the CAS`;
  if (c.pending >= 0.5 && (c.oldest_wait_days ?? 0) > 30 && !c.cas_after_oldest) return `Ask for CAS (${c.oldest_wait_days} days)`;
  if (c.pending >= 0.5) return `Approve ${c.open_calls} waiting call${c.open_calls === 1 ? "" : "s"}`;
  if (c.has_draft) return `Approve draft${c.draft_days != null ? ` (${c.draft_days} days)` : ""}`;
  if (c.has_plan && c.in_bank >= 0.5 && c.buy_left >= 0.5) return `Advise buys: ${L(c.in_bank)} idle`;
  if (c.has_plan && c.left_to_advise >= 0.5) return "Advise next tranche";
  if (c.follow_ups) return "Follow-up due";
  return "—";
}

export type Proof = "CAS" | "APPROVED" | "PRE" | "OFF" | "OPEN";
export const PROOF_LABEL: Record<Proof, string> = {
  CAS: "CAS verified",
  APPROVED: "Approved · waiting for CAS",
  PRE: "Before onboarding (CAS)",
  OFF: "Off-plan (client's own)",
  OPEN: "Not ours? Decide in CAS inbox",
};

/** Proof of a recorded execution: a CAS verified it, a person approved it, or it was done before onboarding (CAS as proof). */
export function proofOf(e: { verification_type: string; cas_verified: boolean }): Proof {
  if (e.verification_type === "CAS_VERIFIED" || e.cas_verified) return "CAS";
  if (e.verification_type === "PROOF_VERIFIED") return "PRE";
  return "APPROVED";
}
