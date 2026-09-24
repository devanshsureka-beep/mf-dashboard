import { Badge } from "@/components/ui/badge";
import { humanize } from "@/lib/format";

type Tone = "neutral" | "info" | "pending" | "success" | "danger" | "purple" | "muted";

/** One consistent colour language for every status in the system. */
const TONES: Record<string, Tone> = {
  // advice
  ISSUED: "info",
  PARTIALLY_EXECUTED: "pending",
  EXECUTED: "success",
  CANCELLED: "muted",
  EXPIRED: "muted",
  REVISED: "purple",
  // executions
  PENDING: "pending",
  PARTIAL: "pending",
  REJECTED: "danger",
  // plans
  DRAFT: "neutral",
  ACTIVE: "info",
  COMPLETED: "success",
  REPLACED: "muted",
  OPEN: "info",
  // plan item progress
  NOT_ADVISED: "neutral",
  AWAITING_EXECUTION: "pending",
  IN_PROGRESS: "info",
  RETAIN: "muted",
  // documents / snapshots
  UPLOADED: "neutral",
  PROCESSING: "info",
  PARSED: "success",
  NEEDS_REVIEW: "pending",
  FAILED: "danger",
  PENDING_REVIEW: "pending",
  CONFIRMED: "success",
  // reconciliation
  SUGGESTED: "info",
  UNEXPLAINED: "danger",
  HIGH: "success",
  MEDIUM: "pending",
  LOW: "danger",
  NONE: "muted",
  // sip
  PLANNED: "neutral",
  ADVISED: "info",
  // client
  PROSPECT: "neutral",
  ONBOARDING: "info",
  DORMANT: "muted",
  CLOSED: "muted",
  // verification
  CAS_VERIFIED: "success",
  PROOF_VERIFIED: "info",
  CLIENT_CONFIRMED: "neutral",
  ADVISOR_CONFIRMED: "neutral",
};

export function StatusBadge({ status, label }: { status: string | null | undefined; label?: string }) {
  if (!status) return null;
  return <Badge tone={TONES[status] ?? "neutral"}>{label ?? humanize(status)}</Badge>;
}

export function ActionBadge({ action }: { action: string }) {
  const tone: Tone = action === "BUY" || action === "START" ? "success" : action === "SELL" || action === "STOP" ? "danger" : action === "SWITCH" || action === "CHANGE" ? "purple" : "muted";
  return <Badge tone={tone} className="font-semibold">{action}</Badge>;
}
