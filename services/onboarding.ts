import type { Actor, Tx } from "@/lib/db/tx";
import { AppError } from "@/lib/errors";
import { advisoryReportResultSchema } from "@/lib/integrations/contracts";
import { buildPlanFromReport, type PlanHolding, type ReportPlanDraft } from "@/lib/domain/report-plan";
import { toCasParseResult, type CasParseOutput } from "@/lib/parsers/cas";
import { sameInvestor, type AdvisoryReportParse } from "@/lib/parsers/advisory-report";
import { createClient } from "@/services/clients";
import { findClientByPan, ingestParsedCas, isDuplicateCas, type StoredFile } from "@/services/cas-intake";
import { registerDocument } from "@/services/documents";
import { ingestAdvisoryReport } from "@/services/plans";
import { resolveOrCreateSecurity, suggestSecurity } from "@/services/securities";
import type { SecurityCandidate } from "@/lib/domain/securities";

/**
 * Onboarding from two documents: the client's CAS and the paid advisory
 * report. Creates (or finds, by PAN) the client, stores both files, saves the
 * CAS as the portfolio snapshot and turns the report into a DRAFT plan for the
 * advisor to review and approve. For an existing client, the new report
 * becomes a new DRAFT; approving it replaces the current plan (history kept).
 */

export interface OnboardingPreview {
  investorName: string | null;
  reportName: string | null;
  pan: string | null;
  namesMatch: boolean;
  existingClient: { id: string; client_code: string; full_name: string } | null;
}

export function checkDocumentsBelongTogether(cas: CasParseOutput, report: AdvisoryReportParse): OnboardingPreview & { problem: string | null } {
  const namesMatch = sameInvestor(cas.investor.name, report.clientName);
  let problem: string | null = null;
  if (!cas.investor.pan) problem = "The CAS does not show the investor's PAN, so the client cannot be identified.";
  else if (!namesMatch) {
    problem = `The CAS is for "${cas.investor.name ?? "unknown"}" but the report is for "${report.clientName ?? "unknown"}".`;
  }
  return { investorName: cas.investor.name, reportName: report.clientName, pan: cas.investor.pan, namesMatch, existingClient: null, problem };
}

export function previewOnboarding(cas: CasParseOutput, report: AdvisoryReportParse): {
  problems: string[];
  draft: ReportPlanDraft | null;
  holdings: PlanHolding[];
} {
  const check = checkDocumentsBelongTogether(cas, report);
  if (check.problem) return { problems: [check.problem], draft: null, holdings: [] };
  let holdings: PlanHolding[];
  try {
    holdings = toCasParseResult(cas, "00000000-0000-0000-0000-000000000000").holdings.map((h) => ({
      scheme_name: h.scheme_name, isin: h.isin ?? null, folio_number: h.folio_number ?? null,
      current_value: h.current_value, plan_type: h.plan_type ?? null,
    }));
  } catch (e) {
    return { problems: [(e as Error).message], draft: null, holdings: [] };
  }
  const draft = buildPlanFromReport(report, holdings, cas.valuationDate);
  return { problems: draft.problems, draft, holdings };
}

/**
 * Everything that must hold before anything is saved: same investor, and every
 * report line tied to the CAS (see buildPlanFromReport). Pure.
 */
export function onboardingProblems(cas: CasParseOutput, report: AdvisoryReportParse): string[] {
  return previewOnboarding(cas, report).problems;
}

export function problemsMessage(problems: string[]): string {
  return [
    `The report and the CAS do not fully reconcile, so nothing was saved. Please check ${problems.length === 1 ? "this point" : `these ${problems.length} points`}:`,
    ...problems.slice(0, 12).map((p, i) => `${i + 1}. ${p}`),
    problems.length > 12 ? `…and ${problems.length - 12} more.` : "",
  ].filter(Boolean).join("\n");
}

export interface OnboardResult {
  clientId: string;
  clientCode: string;
  created: boolean;
  planId: string;
  snapshotId: string | null;
  itemsNeedingReview: number;
  warnings: string[];
}

/** Find the client by the CAS PAN, or create them from the CAS + report details. */
export async function ensureClientFromDocuments(
  tx: Tx,
  actor: Actor,
  args: { cas: CasParseOutput; report: AdvisoryReportParse; advisorId?: string | null; phone?: string | null },
): Promise<{ id: string; client_code: string; full_name: string; created: boolean }> {
  // Nothing is created unless every line of the report ties to the CAS.
  const problems = onboardingProblems(args.cas, args.report);
  if (problems.length) throw new AppError(problemsMessage(problems));
  const existing = await findClientByPan(tx, args.cas.investor.pan);
  if (existing) return { id: existing.id, client_code: existing.client_code, full_name: existing.full_name, created: false };
  const name = args.cas.investor.name ?? args.report.clientName ?? "Unknown";
  const c = await createClient(tx, actor, {
    full_name: name,
    email: args.cas.investor.email?.toLowerCase() ?? null,
    phone: args.phone || args.cas.investor.mobile,
    pan: args.cas.investor.pan,
    risk_profile: args.report.riskProfile,
    goal: args.report.goal,
    status: "ACTIVE",
    advisor_id: args.advisorId || actor.id,
  });
  return { id: c.id, client_code: c.client_code, full_name: name, created: true };
}

export async function onboardFromDocuments(
  tx: Tx,
  actor: Actor,
  args: {
    clientId: string;
    cas: CasParseOutput;
    casFile: StoredFile & { passwordProtected: boolean };
    report: AdvisoryReportParse;
    reportFile: StoredFile;
  },
): Promise<Omit<OnboardResult, "created">> {
  const client = await findClientByPan(tx, args.cas.investor.pan);
  if (!client || client.id !== args.clientId) throw new AppError("The CAS belongs to a different client.");

  // 2) CAS -> snapshot (skipped when this exact file is already stored).
  const warnings: string[] = [];
  let snapshotId: string | null = null;
  if (!(await isDuplicateCas(tx, client.id, args.casFile.sha256))) {
    const cas = await ingestParsedCas(tx, actor, {
      clientId: client.id,
      file: args.casFile,
      parsed: args.cas,
      passwordProtected: args.casFile.passwordProtected,
    });
    snapshotId = cas.snapshotId;
    if (cas.snapshotStatus === "PENDING_REVIEW") warnings.push(`The CAS snapshot needs a check before it counts: ${cas.warnings.join(" ")}`);
  } else {
    // Same file uploaded before: use the snapshot made from that very file.
    const prior = await tx<{ id: string; review_status: string }[]>`
      select s.id, s.review_status from public.portfolio_snapshots s
      join public.cas_documents d on d.id = s.cas_document_id
      where d.client_id = ${client.id} and d.file_sha256 = ${args.casFile.sha256} and s.review_status <> 'REJECTED'
      order by s.created_at desc limit 1`;
    snapshotId = prior[0]?.id ?? null;
    if (prior[0]?.review_status === "PENDING_REVIEW") warnings.push("This CAS was uploaded earlier and its snapshot still needs a check before it counts.");
  }

  // 3) Report document.
  const reportDocId = await registerDocument(tx, actor.id, {
    clientId: client.id,
    type: "ADVISORY_REPORT",
    filePath: args.reportFile.path,
    fileName: args.reportFile.fileName,
    mimeType: args.reportFile.mimeType,
    sizeBytes: args.reportFile.size,
    sha256: args.reportFile.sha256,
    description: `Advisory report${args.report.preparedDate ? ` prepared ${args.report.preparedDate}` : ""}`,
    parseStatus: "PARSED",
  });

  // 4) Plan items, tied to the holdings of the latest snapshot.
  const holdings = await tx<(PlanHolding & { security_id: string | null })[]>`
    select h.scheme_name, h.isin, h.folio_number, h.current_value::float8 as current_value, h.plan_type, h.security_id
    from public.portfolio_holdings h
    where h.snapshot_id = coalesce(${snapshotId}::uuid,
      (select snapshot_id from public.v_latest_snapshot where client_id = ${client.id}))
    order by h.current_value desc`;
  const draft = buildPlanFromReport(args.report, holdings, args.cas.valuationDate);
  if (draft.problems.length) throw new AppError(problemsMessage(draft.problems));

  // Funds to buy are usually new to the client: find them, or create a
  // name-only entry that picks up its ISIN from the first CAS that holds it.
  const securityIds: Record<string, string> = {};
  // Lines tied to a CAS holding use exactly that holding's security.
  for (const h of holdings) if (h.security_id) securityIds[h.scheme_name.toLowerCase()] = h.security_id;
  const pool = await tx<SecurityCandidate[]>`
    select id, scheme_name, isin, plan_type, aliases from public.security_master where is_active`;
  for (const it of [...draft.items.filter((i) => i.action === "BUY"), ...draft.sip_items.filter((s) => !s.isin)]) {
    const key = it.scheme_name.toLowerCase();
    if (securityIds[key]) continue;
    const sug = await suggestSecurity(tx, it.scheme_name, null, pool);
    securityIds[key] = sug.confident && sug.id
      ? sug.id
      : await resolveOrCreateSecurity(tx, { scheme_name: it.scheme_name, amc: "amc" in it ? it.amc ?? null : null, plan_type: it.plan_type ?? null }, actor.id);
  }

  const payload = advisoryReportResultSchema.parse({
    client_id: client.id,
    document_id: reportDocId,
    status: "PARSED",
    plan: {
      plan_name: draft.plan_name,
      plan_date: draft.plan_date,
      starting_portfolio_value: draft.starting_portfolio_value,
      notes: draft.notes,
    },
    items: draft.items.map((i) => ({
      action: i.action, scheme_name: i.scheme_name, isin: i.isin, folio_number: i.folio_number,
      target_amount: i.target_amount, current_amount: i.current_amount, reason: i.reason, priority: i.priority,
    })),
    sip_items: draft.sip_items.map((s) => ({
      action: s.action, scheme_name: s.scheme_name, isin: s.isin, folio_number: s.folio_number,
      old_amount: s.old_amount, new_amount: s.new_amount, frequency: s.frequency, notes: s.notes,
    })),
    declared_totals: { exit_value: draft.declared_totals.exit_value, buy_value: draft.declared_totals.buy_value },
    warnings: draft.warnings,
  });
  const plan = await ingestAdvisoryReport(tx, payload, actor.id, { extractionSource: "IMPORT", securityIds });
  if (!plan.planId) throw new AppError("The plan could not be created from the report.");

  return {
    clientId: client.id,
    clientCode: client.client_code,
    planId: plan.planId,
    snapshotId,
    itemsNeedingReview: plan.itemsNeedingReview,
    warnings: [...warnings, ...plan.warnings],
  };
}
