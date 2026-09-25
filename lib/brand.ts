/**
 * Product naming, in one place. Internal desk for Univest MF Premium (paid
 * mutual-fund advisory) clients; never shown to clients themselves.
 */
export const BRAND = {
  company: "Univest",
  product: "MF Premium",
  desk: "Advisory Desk",
  /** Browser-tab suffix and short references. */
  short: "Univest MF Desk",
} as const;

/** Sidebar / page names, so navigation and page titles never drift apart. */
export const PAGES = {
  overview: "Overview",
  clients: "Premium Clients",
  onboard: "Onboard Client",
  documentCheck: "Document Check",
  callLedger: "Call Ledger",
  pendingExecutions: "Pending Executions",
  bulkCas: "Bulk CAS Upload",
  casMatching: "CAS Matching",
  auditLog: "Audit Log",
  team: "Team & Access",
} as const;

export const ROLE_LABELS: Record<string, string> = {
  ADMIN: "Admin",
  ADVISOR: "Advisor",
  OPERATIONS: "Operations",
};
