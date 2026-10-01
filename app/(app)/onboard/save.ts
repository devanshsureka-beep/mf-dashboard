/**
 * Saving an onboarding (single or bulk): client by PAN, both files stored,
 * CAS snapshot, DRAFT plan. Every report line must tie to the CAS first
 * (ensureClientFromDocuments refuses otherwise).
 */
import { AppError } from "@/lib/errors";
import { withSystemTx, withUserTx, type Actor, type Tx } from "@/lib/db/tx";
import type { CasParseOutput } from "@/lib/parsers/cas";
import type { AdvisoryReportParse } from "@/lib/parsers/advisory-report";
import type { PlanKind } from "@/types/domain";
import { objectPath, uploadAsUser, type PreparedFile } from "@/lib/storage";
import { ensureClientFromDocuments, onboardFromDocuments } from "@/services/onboarding";
import { findClientByPan } from "@/services/cas-intake";
import { getActivePlanId } from "@/services/plans";

/**
 * Advisors and admins onboard under their own database permissions. Operations
 * may onboard too (business decision 2026-10-01): their database role cannot
 * create clients or plans, so this one fully-checked flow runs as the trusted
 * server for them, labelled with their email in the audit log, and the plan
 * still opens as a DRAFT that an advisor or admin approves.
 */
export function onboardingTx(actor: Actor) {
  return <T>(fn: (tx: Tx, actor: Actor) => Promise<T>): Promise<T> =>
    actor.role === "OPERATIONS"
      ? withSystemTx(`onboarding:${actor.email}`, (tx) => fn(tx, actor))
      : withUserTx(actor, (tx) => fn(tx, actor));
}

/** Operations must name an active advisor/admin; others may leave it empty (themselves). */
export async function checkAdvisor(actor: Actor, advisorId: string | null): Promise<void> {
  if (!advisorId) {
    if (actor.role === "OPERATIONS") throw new AppError("Choose the primary advisor for this client.");
    return;
  }
  const ok = await onboardingTx(actor)((tx) => tx<{ id: string }[]>`
    select id from public.profiles where id = ${advisorId} and role in ('ADVISOR', 'ADMIN') and is_active`);
  if (!ok[0]) throw new AppError("Choose an active advisor.");
}

/** Does the client with this PAN already have an ACTIVE plan (an additional investment can be added to it)? */
export async function hasActivePlanForPan(actor: Actor, pan: string | null): Promise<boolean> {
  if (!pan) return false;
  return onboardingTx(actor)(async (tx) => {
    const c = await findClientByPan(tx, pan);
    return c ? Boolean(await getActivePlanId(tx, c.id)) : false;
  });
}

export interface SavedOnboarding {
  clientId: string;
  clientCode: string;
  clientName: string;
  created: boolean;
  planId: string;
  kind: PlanKind;
  itemsNeedingReview: number;
  warnings: string[];
}

export async function saveOnboarding(
  actor: Actor,
  args: {
    cas: CasParseOutput;
    casFile: PreparedFile;
    passwordProtected: boolean;
    report: AdvisoryReportParse;
    reportFile: PreparedFile;
    advisorId: string | null;
    phone: string | null;
    kind?: PlanKind;
  },
): Promise<SavedOnboarding> {
  const run = onboardingTx(actor);
  const client = await run((tx, a) => ensureClientFromDocuments(tx, a, { cas: args.cas, report: args.report, advisorId: args.advisorId, phone: args.phone, kind: args.kind }));

  const casPath = objectPath(client.id, "CAS", args.casFile);
  const reportPath = objectPath(client.id, "ADVISORY_REPORT", args.reportFile);
  await uploadAsUser(casPath, args.casFile);
  await uploadAsUser(reportPath, args.reportFile);

  const out = await run((tx, a) => onboardFromDocuments(tx, a, {
    clientId: client.id,
    cas: args.cas,
    casFile: { fileName: args.casFile.fileName, mimeType: args.casFile.mimeType, size: args.casFile.size, sha256: args.casFile.sha256, path: casPath, passwordProtected: args.passwordProtected },
    report: args.report,
    reportFile: { fileName: args.reportFile.fileName, mimeType: args.reportFile.mimeType, size: args.reportFile.size, sha256: args.reportFile.sha256, path: reportPath },
    kind: args.kind,
  }));
  return {
    clientId: out.clientId, clientCode: out.clientCode, clientName: client.full_name, created: client.created,
    planId: out.planId, kind: args.kind ?? "FULL", itemsNeedingReview: out.itemsNeedingReview, warnings: out.warnings,
  };
}
