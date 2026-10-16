import type { Actor, Tx } from "@/lib/db/tx";
import { AppError } from "@/lib/errors";
import { advisoryReportResultSchema } from "@/lib/integrations/contracts";
import { buildPlanFromReport, type PlanHolding, type ReportPlanDraft, type SinceTrade } from "@/lib/domain/report-plan";
import { toCasParseResult, type CasParseOutput } from "@/lib/parsers/cas";
import { sameInvestor, type AdvisoryReportParse } from "@/lib/parsers/advisory-report";
import { createClient } from "@/services/clients";
import { findClientByPan, findClientForCas, ingestParsedCas, isDuplicateCas, type StoredFile } from "@/services/cas-intake";
import { registerDocument } from "@/services/documents";
import { ingestAdvisoryReport } from "@/services/plans";
import { resolveOrCreateSecurity, suggestSecurity } from "@/services/securities";
import { findDirectVariant } from "@/services/migrations";
import type { SecurityCandidate } from "@/lib/domain/securities";
import { RISK_PROFILES, type AsReported, type PlanKind } from "@/types/domain";

/** The desk's choice to onboard although the report and the CAS differ. */
export interface AsReportedChoice { reason: string; points: string[] }

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

/** The CAS holdings in the shape the report tie-out uses (throws on a CAS that does not reconcile). */
export function holdingsFromCas(cas: CasParseOutput): PlanHolding[] {
  return toCasParseResult(cas, "00000000-0000-0000-0000-000000000000").holdings.map((h) => ({
    scheme_name: h.scheme_name, isin: h.isin ?? null, folio_number: h.folio_number ?? null,
    current_value: h.current_value, plan_type: h.plan_type ?? null,
  }));
}

/** The CAS's trades, for a report made from an earlier CAS (only those after the report's date count as done since). */
export function tradesFromCas(cas: CasParseOutput): SinceTrade[] {
  return toCasParseResult(cas, "00000000-0000-0000-0000-000000000000").transactions.map((t) => ({
    scheme_name: t.scheme_name, isin: t.isin ?? null, date: t.date, type: t.type, amount: Number(t.amount ?? 0),
  }));
}

export function previewOnboarding(cas: CasParseOutput, report: AdvisoryReportParse, kind: PlanKind = "FULL", opts: { newerCas?: boolean } = {}): {
  problems: string[];
  draft: ReportPlanDraft | null;
  holdings: PlanHolding[];
} {
  const check = checkDocumentsBelongTogether(cas, report);
  if (check.problem) return { problems: [check.problem], draft: null, holdings: [] };
  let holdings: PlanHolding[];
  try {
    holdings = holdingsFromCas(cas);
  } catch (e) {
    return { problems: [(e as Error).message], draft: null, holdings: [] };
  }
  const draft = buildPlanFromReport(report, holdings, cas.valuationDate, {
    additional: kind === "ADDITIONAL",
    // A CAS newer than the report: differences become questions, prefilled from the trades since the report.
    since: opts.newerCas ? { trades: tradesFromCas(cas) } : undefined,
  });
  return { problems: draft.problems, draft, holdings };
}

export type ReportKindChoice = "AUTO" | PlanKind;

/**
 * Full rebalancing (replaces the plan) or additional investment (fresh money,
 * added to the ACTIVE plan as a tranche). AUTO picks ADDITIONAL only for a
 * client with an active plan whose report reads as fresh money on top of it:
 * Claude says so, or the report does not cover the portfolio yet ties out as
 * an addition with buys.
 */
export function decideReportKind(
  cas: CasParseOutput,
  report: AdvisoryReportParse,
  args: { choice: ReportKindChoice; hasActivePlan: boolean; newerCas?: boolean },
): { kind: PlanKind; problems: string[]; draft: ReportPlanDraft | null } {
  const as = (kind: PlanKind) => {
    const p = previewOnboarding(cas, report, kind, { newerCas: args.newerCas });
    const problems = kind === "ADDITIONAL" && !args.hasActivePlan
      ? ["This client has no active plan to add to: onboard and approve a full plan first, or choose Full rebalancing.", ...p.problems]
      : p.problems;
    return { kind, problems, draft: p.draft };
  };
  if (args.choice !== "AUTO") return as(args.choice);
  if (!args.hasActivePlan) return as("FULL");
  if (report.reportKind === "ADDITIONAL") return as("ADDITIONAL");
  const full = as("FULL");
  if (!full.problems.length) return full;
  const add = as("ADDITIONAL");
  const buys = add.draft?.items.some((i) => i.action === "BUY") ?? false;
  const notCovered = full.problems.some((x) => /not covered by the report/.test(x));
  return !add.problems.length && buys && notCovered ? add : full;
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
  args: { cas: CasParseOutput; report: AdvisoryReportParse; advisorId?: string | null; phone?: string | null; kind?: PlanKind; newerCas?: boolean; asReported?: AsReportedChoice | null },
): Promise<{ id: string; client_code: string; full_name: string; created: boolean }> {
  if (args.asReported) {
    // Report as it is: the differences are accepted, but the two documents must still be the same investor's.
    // (A report that prints no name is paired by the desk; one naming someone else is never taken.)
    const together = checkDocumentsBelongTogether(args.cas, args.report);
    if (together.problem && (args.report.clientName || !args.cas.investor.pan)) throw new AppError(together.problem);
    holdingsFromCas(args.cas); // a CAS that does not reconcile in itself is never accepted
  } else {
    // Nothing is created unless every line of the report ties to the CAS (or, for a newer CAS, is asked about).
    const problems = previewOnboarding(args.cas, args.report, args.kind ?? "FULL", { newerCas: args.newerCas }).problems;
    if (problems.length) throw new AppError(problemsMessage(problems));
  }
  const existing = await findClientForCas(tx, args.cas.investor, { claim: true });
  if (existing) return { id: existing.id, client_code: existing.client_code, full_name: existing.full_name, created: false };
  const name = args.cas.investor.name ?? args.report.clientName ?? "Unknown";
  const c = await createClient(tx, actor, {
    full_name: name,
    email: args.cas.investor.email?.toLowerCase() ?? null,
    phone: args.phone || args.cas.investor.mobile,
    pan: args.cas.investor.pan,
    risk_profile: (RISK_PROFILES as string[]).includes(args.report.riskProfile ?? "") ? args.report.riskProfile : null,
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
    kind?: PlanKind;
    /** The CAS was taken after the report: differences become questions on the plan. */
    newerCas?: boolean;
    /** Onboard with the report as it is: these differences from the CAS are accepted. */
    asReported?: AsReportedChoice | null;
  },
): Promise<Omit<OnboardResult, "created">> {
  const kind = args.kind ?? "FULL";
  const client = await findClientForCas(tx, args.cas.investor, { claim: true });
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
  const draft = buildPlanFromReport(args.report, holdings, args.cas.valuationDate, {
    additional: kind === "ADDITIONAL",
    since: args.newerCas && !args.asReported ? { trades: tradesFromCas(args.cas) } : undefined,
    asReported: Boolean(args.asReported),
  });
  if (draft.problems.length) throw new AppError(problemsMessage(draft.problems));
  const asReported: AsReported | null = args.asReported ? {
    reason: args.asReported.reason,
    points: args.asReported.points.slice(0, 200),
    outside: (draft.outside ?? []).map((h) => ({ scheme_name: h.scheme_name, isin: h.isin, folio_number: h.folio_number, value: Math.round(h.current_value * 100) / 100 })),
    by: actor.id,
    at: new Date().toISOString(),
  } : null;
  if (asReported) {
    const outsideTotal = asReported.outside.reduce((t, o) => t + o.value, 0);
    draft.notes = [
      draft.notes,
      `Onboarded with the report as it is (${asReported.points.length} difference(s) from the CAS accepted): ${asReported.reason}`,
      asReported.outside.length ? `Outside the advised portfolio (${asReported.outside.length} fund(s), ₹${Math.round(outsideTotal).toLocaleString("en-IN")} in the CAS): not plan lines.` : null,
    ].filter(Boolean).join("\n");
  }

  const plan = await planFromDraft(tx, actor, { clientId: client.id, reportDocId, report: args.report, draft, holdings, asReported });

  return {
    clientId: client.id,
    clientCode: client.client_code,
    planId: plan.planId,
    snapshotId,
    itemsNeedingReview: plan.itemsNeedingReview,
    warnings: [...warnings, ...plan.warnings],
  };
}

/**
 * The draft (already tied to the holdings) -> securities for every line -> a
 * DRAFT plan. Funds to buy are found by name or created name-only.
 */
async function planFromDraft(
  tx: Tx,
  actor: Actor,
  args: { clientId: string; reportDocId: string; report: AdvisoryReportParse; draft: ReportPlanDraft; holdings: (PlanHolding & { security_id: string | null })[]; planName?: string; asReported?: AsReported | null },
): Promise<{ planId: string; itemsNeedingReview: number; warnings: string[] }> {
  const { draft, holdings, reportDocId } = args;
  // Funds to buy are usually new to the client: find them, or create a
  // name-only entry that picks up its ISIN from the first CAS that holds it.
  const securityIds: Record<string, string> = {};
  // Lines tied to a CAS holding use exactly that holding's security.
  for (const h of holdings) if (h.security_id) securityIds[h.scheme_name.toLowerCase()] = h.security_id;
  const pool = await tx<SecurityCandidate[]>`
    select id, scheme_name, isin, plan_type, aliases from public.security_master where is_active`;
  // Migrate to Direct: the real Direct plan from the AMFI list when it is clear, else a name-only entry.
  for (const i of draft.items.filter((x) => x.action === "MIGRATE" && x.switch_to_scheme_name)) {
    const to = await findDirectVariant(tx, i.isin, actor.id);
    if (to) securityIds[(i.switch_to_scheme_name as string).toLowerCase()] = to;
  }
  const migrations = draft.items
    .filter((i) => i.action === "MIGRATE" && i.switch_to_scheme_name)
    .map((i) => ({ scheme_name: i.switch_to_scheme_name as string, plan_type: "DIRECT" as const, amc: null }));
  for (const it of [...draft.items.filter((i) => i.action === "BUY"), ...draft.sip_items.filter((s) => !s.isin), ...migrations]) {
    const key = it.scheme_name.toLowerCase();
    if (securityIds[key]) continue;
    const sug = await suggestSecurity(tx, it.scheme_name, null, pool);
    securityIds[key] = sug.confident && sug.id
      ? sug.id
      : await resolveOrCreateSecurity(tx, { scheme_name: it.scheme_name, amc: "amc" in it ? it.amc ?? null : null, plan_type: it.plan_type ?? null }, actor.id);
  }

  const payload = advisoryReportResultSchema.parse({
    client_id: args.clientId,
    document_id: reportDocId,
    status: "PARSED",
    plan: {
      plan_name: args.planName ?? draft.plan_name,
      plan_date: draft.plan_date,
      starting_portfolio_value: draft.starting_portfolio_value,
      notes: draft.notes,
      plan_kind: draft.plan_kind,
      fresh_money: draft.fresh_money,
      as_reported: args.asReported ?? null,
    },
    items: draft.items.map((i) => ({
      action: i.action, scheme_name: i.scheme_name, isin: i.isin, folio_number: i.folio_number,
      target_amount: i.target_amount, current_amount: i.current_amount, reason: i.reason, priority: i.priority,
      switch_to_scheme_name: i.switch_to_scheme_name ?? null,
      question: i.question ?? null,
      report_diff: i.diff ?? null,
    })),
    sip_items: draft.sip_items.map((s) => ({
      action: s.action, scheme_name: s.scheme_name, isin: s.isin, folio_number: s.folio_number,
      old_amount: s.old_amount, new_amount: s.new_amount, frequency: s.frequency, notes: s.notes,
    })),
    declared_totals: { exit_value: draft.declared_totals.exit_value, buy_value: draft.declared_totals.buy_value },
    unchanged_sips: draft.unchanged_sips ?? [],
    warnings: draft.warnings,
  });
  const plan = await ingestAdvisoryReport(tx, payload, actor.id, { extractionSource: args.report.template === "AI_ASSISTED" ? "AI_EXTRACTION" : "IMPORT", securityIds, allowAsReported: true });
  if (!plan.planId) throw new AppError("The plan could not be created from the report.");
  return { planId: plan.planId, itemsNeedingReview: plan.itemsNeedingReview, warnings: plan.warnings };
}

// -----------------------------------------------------------------------------
// A new investor: no mutual funds yet, so no CAS. The report alone gives the
// plan (buys and SIPs, all with fresh money); the first CAS later shows the buys.
// -----------------------------------------------------------------------------
export interface NewInvestorDetails {
  /** Empty: the name printed in the report. */
  fullName?: string | null;
  /** Optional: the client's first CAS gives it (see findClientForCas). */
  pan?: string | null;
  /** Required: the CAS password and the way the first CAS finds the client. */
  phone?: string | null;
  email?: string | null;
}

/** The client's name: as typed, else as the report prints it. */
export const newInvestorName = (who: NewInvestorDetails, report: AdvisoryReportParse) => (who.fullName?.trim() || report.clientName?.trim() || "");

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/** Everything that must hold before a new investor is saved. Pure. */
export function previewNewInvestor(report: AdvisoryReportParse, who: NewInvestorDetails): { problems: string[]; draft: ReportPlanDraft | null } {
  const problems: string[] = [];
  if (!newInvestorName(who, report)) problems.push("The report shows no client name: read it again, or check it is a Univest advisory report.");
  if (!/^[6-9][0-9]{9}$/.test((who.phone ?? "").replace(/\D/g, "").slice(-10))) problems.push("Enter the client's 10-digit mobile number: their first CAS opens and is matched with it.");
  const pan = who.pan?.trim().toUpperCase() ?? "";
  if (pan && !PAN_RE.test(pan)) problems.push("Enter a valid PAN (e.g. ABCDE1234F), or leave it empty: the first CAS gives it.");
  if (report.clientName && who.fullName?.trim() && !sameInvestor(who.fullName, report.clientName)) {
    problems.push(`The report is for "${report.clientName}", not "${who.fullName.trim()}".`);
  }
  if (report.sells.length) {
    problems.push(`The report sells ${report.sells.length} fund(s), so the client already holds mutual funds: onboard them with their CAS instead.`);
    return { problems, draft: null };
  }
  // No holdings: the plan is new money only (fresh money = what it buys).
  const draft = buildPlanFromReport({ ...report, review: [] }, [], null, { additional: true });
  problems.push(...draft.problems.filter((p) => !/additional-investment report has no buy/.test(p)));
  if (!draft.items.some((i) => i.action === "BUY") && !draft.sip_items.some((s) => s.action === "START")) {
    problems.push("The report has no fund to buy and no SIP to start.");
  }
  const sipStops = draft.sip_items.filter((s) => s.action !== "START");
  if (sipStops.length) problems.push(`The report stops or changes ${sipStops.length} SIP(s), which a new investor does not have: onboard with their CAS instead.`);
  return { problems, draft };
}

/** New-investor problems no "as it is" can accept: the name / PAN, or a report for someone who already holds funds. */
export const isBlockingNewInvestorProblem = (p: string) => /^Enter |is for "|already holds mutual funds|does not have: onboard|shows no client name/.test(p);

/** Step 1: create the client (refused when the PAN is already a client or the report does not hold up). */
export async function createNewInvestor(
  tx: Tx,
  actor: Actor,
  args: { who: NewInvestorDetails; advisorId?: string | null; report: AdvisoryReportParse; asReported?: AsReportedChoice | null },
): Promise<{ id: string; client_code: string }> {
  const { problems } = previewNewInvestor(args.report, args.who);
  const blocking = args.asReported ? problems.filter(isBlockingNewInvestorProblem) : problems;
  if (blocking.length) throw new AppError(newInvestorMessage(blocking));
  const pan = args.who.pan?.trim().toUpperCase() || null;
  const phone = (args.who.phone ?? "").replace(/\D/g, "").slice(-10);
  // Without a PAN the mobile number tells clients apart.
  const existing = pan ? await findClientByPan(tx, pan)
    : (await tx<{ id: string; client_code: string; full_name: string }[]>`
        select id, client_code, full_name from public.clients
        where deleted_at is null and right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) = ${phone}
        order by created_at limit 1`)[0] ?? null;
  if (existing) {
    // An earlier attempt that stopped after creating the client (no plan, no CAS yet): carry on with it.
    const unfinished = (await tx<{ ok: boolean }[]>`
      select not exists (select 1 from public.advisory_plans where client_id = ${existing.id})
         and not exists (select 1 from public.cas_documents where client_id = ${existing.id})
         and exists (select 1 from public.portfolio_snapshots where client_id = ${existing.id} and is_baseline and source = 'MANUAL' and holdings_count = 0) as ok`)[0]?.ok;
    if (unfinished) return { id: existing.id, client_code: existing.client_code };
    throw new AppError(`${existing.full_name} (${existing.client_code}) already has this ${pan ? "PAN" : "mobile number"}: upload the report on their page instead.`);
  }
  const c = await createClient(tx, actor, {
    full_name: newInvestorName(args.who, args.report),
    email: args.who.email?.trim().toLowerCase() || null,
    phone: phone || null,
    pan,
    risk_profile: (RISK_PROFILES as string[]).includes(args.report.riskProfile ?? "") ? args.report.riskProfile : null,
    goal: args.report.goal,
    status: "ACTIVE",
    advisor_id: args.advisorId || actor.id,
  });
  // The starting point: nothing held (dated the day before, so a buy on the onboarding
  // day still counts as a trade after it). The first CAS is compared with this
  // empty baseline, so its purchases complete the buy calls (and "since
  // onboarding" starts from the fresh money, not from the first CAS).
  await tx`
    insert into public.portfolio_snapshots
      (client_id, cas_document_id, snapshot_date, total_invested_value, total_current_value, source, extraction_method,
       review_status, reviewed_at, reviewed_by, review_note, is_baseline, holdings_count, created_by)
    values (${c.id}, null, app.today_ist() - 1, 0, 0, 'MANUAL', 'MANUAL',
            'CONFIRMED', now(), ${actor.id}, 'New investor: no mutual funds at onboarding', true, 0, ${actor.id})`;
  return c;
}

export function newInvestorMessage(problems: string[]): string {
  return problemsMessage(problems).replace("The report and the CAS do not fully reconcile", "The report cannot be onboarded as it is");
}

/** Step 2 (after the report file is stored): the report document and the DRAFT plan (buys and SIP starts, fresh money). */
export async function newInvestorPlan(
  tx: Tx,
  actor: Actor,
  args: { clientId: string; who: NewInvestorDetails; report: AdvisoryReportParse; reportFile: StoredFile; asReported?: AsReportedChoice | null },
): Promise<{ planId: string; itemsNeedingReview: number; warnings: string[] }> {
  const { problems, draft } = previewNewInvestor(args.report, args.who);
  const blocking = args.asReported ? problems.filter(isBlockingNewInvestorProblem) : problems;
  if (blocking.length || !draft) throw new AppError(newInvestorMessage(blocking.length ? blocking : problems));
  const reportDocId = await registerDocument(tx, actor.id, {
    clientId: args.clientId,
    type: "ADVISORY_REPORT",
    filePath: args.reportFile.path,
    fileName: args.reportFile.fileName,
    mimeType: args.reportFile.mimeType,
    sizeBytes: args.reportFile.size,
    sha256: args.reportFile.sha256,
    description: `Advisory report (new investor)${args.report.preparedDate ? ` prepared ${args.report.preparedDate}` : ""}`,
    parseStatus: "PARSED",
  });
  const notes = [
    "New investor: no mutual funds before Univest. Everything is bought with fresh money; the first CAS shows the buys.",
    draft.notes.split("\n").filter((l) => !/^Additional investment/.test(l)).join("\n"),
    args.asReported ? `Onboarded with the report as it is (${problems.length} point(s) accepted): ${args.asReported.reason}` : null,
  ].filter(Boolean).join("\n");
  return planFromDraft(tx, actor, {
    clientId: args.clientId, reportDocId, report: args.report, draft: { ...draft, plan_kind: "FULL", notes, problems: [] }, holdings: [],
    planName: `First investment plan${args.report.preparedDate ? ` · ${args.report.preparedDate}` : ""}`,
    asReported: args.asReported ? { reason: args.asReported.reason, points: problems.slice(0, 200), outside: [], by: actor.id, at: new Date().toISOString() } : null,
  });
}
