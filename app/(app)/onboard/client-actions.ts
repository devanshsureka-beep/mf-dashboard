"use server";

import { revalidatePath } from "next/cache";
import { askClaudeWhatPdfIs, readCasAnyPdf } from "@/lib/integrations/cas-ai";
import { num, str } from "@/lib/actions";
import { casPasswordTemplate, fileNamePasswords, passwordCandidates } from "@/lib/cas/password";
import { identifyPdf, readReportDetailed } from "@/lib/cas/reader";
import { AppError, logServerError, toUserMessage } from "@/lib/errors";
import { reportAiConfigured } from "@/lib/integrations/report-ai";
import { requireActorForAction } from "@/lib/auth/session";
import { ALL_ROLES } from "@/lib/server";
import { maskPan } from "@/lib/format";
import { type PreparedFile, fileFromForm, formFileName } from "@/lib/storage";
import type { AdvisoryReportParse } from "@/lib/parsers/advisory-report";
import { findClientByPan, findClientForCas, knownClientPhones } from "@/services/cas-intake";
import { findDuplicateDocument } from "@/services/portfolio";
import { checkDocumentsBelongTogether, decideReportKind, type ReportKindChoice } from "@/services/onboarding";
import type { PlanKind } from "@/types/domain";
import { isStaleCasProblem } from "@/lib/domain/report-plan";
import { resolveWithClaude } from "@/services/report-resolve";
import { listDraftPlans } from "@/services/plans";
import { checkAdvisor, hasActivePlanForPan, onboardingTx, saveOnboarding } from "./save";

/**
 * Client onboarding from any number of CAS + report PDFs (one client or a
 * whole folder) with no naming rule. Step 1 reads each file (what it is,
 * whose it is); step 2 onboards one CAS + report pair per call. CAS passwords are tried from the file name,
 * the house template and known mobiles, kept in memory only, and stripped
 * from the stored file names. Request bodies are never logged.
 */

export interface BulkFileInfo {
  fileName: string;
  kind: "CAS" | "REPORT" | "LOCKED" | "UNREADABLE";
  name: string | null;
  panMasked: string | null;
  casDate: string | null;
  /** Report: the date of the CAS it was made from (or the day it was prepared). */
  reportDate: string | null;
  /** Report: the built-in reader understood its layout. */
  readerOk: boolean;
  existingClient: string | null;
  message: string;
}


async function candidatesFor(actorRun: ReturnType<typeof onboardingTx>, fileName: string, typed: string | null = null): Promise<string[]> {
  const phones = await actorRun((tx) => knownClientPhones(tx));
  return passwordCandidates({ template: casPasswordTemplate(), explicit: [typed], fileName, phones, fileNameParts: true });
}

/** The date of the CAS the report was made from (else the day it was prepared). */
const reportDateOf = (r: AdvisoryReportParse): string | null => r.valuationDate ?? r.casPeriod?.to ?? r.preparedDate ?? null;

export async function identifyBulkFileAction(fd: FormData): Promise<BulkFileInfo> {
  const fileName = formFileName(fd, "file");
  const base: BulkFileInfo = { fileName, kind: "UNREADABLE", name: null, panMasked: null, casDate: null, reportDate: null, readerOk: false, existingClient: null, message: "" };
  try {
    const actor = await requireActorForAction(ALL_ROLES);
    const run = onboardingTx(actor);
    const file = await fileFromForm(fd, "file");
    if (file.mimeType !== "application/pdf") return { ...base, message: "Not a PDF." };
    const id = await identifyPdf(file.bytes, await candidatesFor(run, file.fileName, str(fd, "password") || null));
    switch (id.kind) {
      case "CAS": {
        const existing = await run((tx) => findClientForCas(tx, id.cas.investor));
        return {
          ...base, kind: "CAS", name: id.cas.investor.name, panMasked: maskPan(id.cas.investor.pan), casDate: id.cas.valuationDate,
          existingClient: existing ? `${existing.full_name} (${existing.client_code})` : null,
          message: id.cas.investor.pan ? "" : "This CAS shows no PAN, so the client cannot be identified.",
        };
      }
      case "REPORT":
        return {
          ...base, kind: "REPORT", name: id.nameGuess, readerOk: id.report !== null, reportDate: id.report ? reportDateOf(id.report) : null,
          message: id.report ? "" : `Layout not known to the built-in reader${reportAiConfigured() ? "; Claude will read it" : ""}.`,
        };
      case "LOCKED":
        return { ...base, kind: "LOCKED", message: "Password protected, and neither the file name nor a saved mobile opened it. Type the password under More options, then read again." };
      case "IMAGE_ONLY": {
        // Pages are pictures: Claude says what it is and whose; the pair step then reads it in full.
        if (id.locked) return { ...base, message: "Its pages are pictures and it is password protected, so it cannot be read. Upload the original PDF." };
        if (!reportAiConfigured()) return { ...base, message: "Its pages are pictures (scanned / \"Microsoft Print to PDF\") and the Claude reader is not set up. Upload the original PDF." };
        const what = await askClaudeWhatPdfIs(file.bytes);
        if (what.kind === "OTHER") return { ...base, message: "Its pages are pictures, and Claude says it is neither a CAS nor an advisory report." };
        const existing = what.kind === "CAS" && what.pan ? await run((tx) => findClientByPan(tx, what.pan)) : null;
        return {
          ...base, kind: what.kind, name: what.name, panMasked: what.pan ? maskPan(what.pan) : null, casDate: what.kind === "CAS" ? what.date : null,
          existingClient: existing ? `${existing.full_name} (${existing.client_code})` : null,
          message: what.kind === "CAS" ? "Pages are pictures: Claude will read this CAS (its snapshot then needs a check)." : "Pages are pictures: Claude will read this report.",
        };
      }
      case "CAS_UNREADABLE":
        return { ...base, message: `A CAS, but it could not be read: ${id.error}` };
      default:
        return { ...base, message: id.error };
    }
  } catch (e) {
    if (!(e instanceof AppError)) logServerError("bulk-onboard:identify", e);
    return { ...base, message: toUserMessage(e) };
  }
}

/** What the new draft holds (shown per client after onboarding). */
export interface DraftSummary { sells: number; buys: number; sipLines: number; keeps: number; questions: number; toCheck: number }

export interface BulkOnboardRow {
  outcome: "ONBOARDED" | "NEEDS_REVIEW" | "ALREADY" | "FAILED";
  /** The CAS is dated after the report: what the client already did became questions on the draft. */
  newerCas?: boolean;
  /** Onboarded with the report as it is: this many differences from the CAS were accepted. */
  accepted?: number;
  draft?: DraftSummary;
  message: string;
  problems: string[];
  usedClaude: boolean;
  corrections: string[];
  clientId?: string;
  clientName?: string;
  clientCode?: string;
  planId?: string;
  created?: boolean;
}

const fail = (outcome: BulkOnboardRow["outcome"], message: string, extra: Partial<BulkOnboardRow> = {}): BulkOnboardRow =>
  ({ outcome, message, problems: [], usedClaude: false, corrections: [], ...extra });

/** Stored names carry no password (file names may hold one). */
const storedAs = (f: PreparedFile, name: string): PreparedFile => ({ ...f, fileName: name.replace(/[^\w .()-]+/g, " ").replace(/\s+/g, " ").trim() });

/** The page allows 300 s per request: Claude rounds end by 240 s, the rest is for saving. */
const CLAUDE_BUDGET_MS = 240_000; // leaves time to save the client, files and plan

export async function onboardBulkPairAction(fd: FormData): Promise<BulkOnboardRow> {
  const deadline = Date.now() + CLAUDE_BUDGET_MS;
  try {
    const actor = await requireActorForAction(ALL_ROLES);
    const run = onboardingTx(actor);
    const advisorId = str(fd, "advisor_id") || null;
    await checkAdvisor(actor, advisorId);
    // "Onboard with the report as it is": the differences from the CAS are accepted, with a reason.
    const asReason = str(fd, "as_reported_reason").slice(0, 500) || null;
    if (asReason && actor.role === "OPERATIONS") return fail("FAILED", "Only an advisor or an admin can onboard with the report as it is.");
    if (asReason !== null && asReason.length < 3) return fail("FAILED", "Write why the report is taken as it is (e.g. the client is advised on part of the portfolio).");
    let accepted: string[] | null = null;

    const casUpload = await fileFromForm(fd, "cas");
    const reportUpload = await fileFromForm(fd, "report");
    if (casUpload.mimeType !== "application/pdf" || reportUpload.mimeType !== "application/pdf") return fail("FAILED", "Both files must be PDFs.");

    const casCandidates = await candidatesFor(run, casUpload.fileName, str(fd, "password") || null);
    const { parsed: cas, passwordProtected } = await readCasAnyPdf(casUpload.bytes, casCandidates, { timeoutMs: Math.min(200_000, deadline - Date.now()) });
    if (!cas.investor.pan) return fail("FAILED", "The CAS shows no PAN, so the client cannot be identified.");

    // Same report already onboarded for this client: nothing to do.
    const existing = await run((tx) => findClientForCas(tx, cas.investor));
    if (existing) {
      const dup = await run((tx) => findDuplicateDocument(tx, existing.id, "ADVISORY_REPORT", reportUpload.sha256));
      if (dup) {
        return fail("ALREADY", "This report was already onboarded for this client.", {
          clientId: existing.id, clientName: existing.full_name, clientCode: existing.client_code,
        });
      }
    }

    // 1) Built-in readers.
    const read = await readReportDetailed(reportUpload.bytes, [...fileNamePasswords(reportUpload.fileName), ...casCandidates]);
    const fresh = num(fd, "fresh_money");
    const withFresh = (r: AdvisoryReportParse): AdvisoryReportParse => (fresh && fresh > 0 ? { ...r, freshMoney: fresh } : r);
    let report: AdvisoryReportParse | null = read.report ? withFresh(read.report) : null;
    if (report) {
      const together = checkDocumentsBelongTogether(cas, report);
      if (together.problem && report.clientName) return fail("FAILED", `${together.problem} Pair this CAS with the right report.`);
    }
    // Full rebalancing, or fresh money added to the client's active plan (decided per report).
    const hasActivePlan = await hasActivePlanForPan(actor, cas.investor.pan);
    const rk = str(fd, "report_kind");
    const choice: ReportKindChoice = rk === "FULL" || rk === "ADDITIONAL" ? rk : "AUTO";
    // A CAS dated after the report: the client already acted on part of it, so each
    // difference becomes a question on the draft (prefilled from the CAS trades since).
    const newerThan = (r: AdvisoryReportParse) => {
      const d = reportDateOf(r);
      return Boolean(cas.valuationDate && d && cas.valuationDate > d);
    };
    const check = (r: AdvisoryReportParse) => decideReportKind(cas, withFresh(r), { choice, hasActivePlan, newerCas: newerThan(r) });
    const first = report ? check(report) : null;
    let kind: PlanKind = first?.kind ?? "FULL";
    const problems = first ? first.problems : [`The built-in reader could not read the report: ${read.error}`];
    let usedClaude = false;
    let corrections: string[] = [];

    // 2) Claude for what did not reconcile (points still open go back to Claude);
    //    every answer passes the same CAS tie-out.
    // A CAS older than the report is never taken "as it is": the plan would sit on holdings that already changed.
    if (problems.some(isStaleCasProblem)) {
      return fail("NEEDS_REVIEW", "The CAS is older than the one the report was made from. Upload the client's newer CAS with this report.", { problems });
    }
    if (problems.length) {
      if (!reportAiConfigured() && asReason && report) accepted = problems;
      else if (!reportAiConfigured()) {
        return fail("NEEDS_REVIEW", "The report does not reconcile with the CAS, and the Claude reader is not set up.", { problems });
      }
    }
    if (problems.length && !accepted) {
      // Taking the report as it is: Claude only needs to read it well, not to make it tie out (fewer rounds).
      const r = await resolveWithClaude({ cas, reportPdf: reportUpload.bytes, draft: report, readerError: read.error, problems, deadline, reportFileName: reportUpload.fileName, check,
        maxRounds: asReason ? (report ? 1 : 2) : undefined });
      usedClaude = r.rounds > 0;
      corrections = r.corrections;
      if (r.status === "WRONG_PAIR") return fail("FAILED", `${r.message} Pair this CAS with the right report.`, { usedClaude, corrections });
      const best = r.status === "OPEN" ? r.report ?? report : null;
      if (r.status === "OPEN" && asReason && best) {
        // Taken as it is: the best reading (Claude's last, else the built-in reader's), the open points accepted.
        report = withFresh(best);
        accepted = r.problems;
      } else if (r.status === "OPEN" && r.problems.some(isStaleCasProblem)) {
        return fail("NEEDS_REVIEW", "The CAS is older than the one the report was made from. Upload the client's newer CAS with this report.", { problems: r.problems, usedClaude, corrections });
      }
      else if (r.status === "OPEN") {
        return fail("NEEDS_REVIEW", r.error && !usedClaude
          ? `The report does not reconcile, and Claude could not help: ${r.error}`
          : `Even after Claude re-read the report${r.rounds > 1 ? ` (${r.rounds} rounds)` : ""}, these points do not reconcile with the CAS.${r.error ? ` (${r.error})` : ""}`,
        { problems: r.problems, usedClaude, corrections });
      } else if (r.status === "RESOLVED") {
        report = withFresh(r.report);
        kind = r.kind;
      }
    }
    if (!report) return fail("FAILED", accepted || asReason ? "The report could not be read at all, so there is nothing to onboard from." : "The report could not be read.");
    if (accepted) kind = choice === "ADDITIONAL" ? "ADDITIONAL" : check(report).kind;

    const who = cas.investor.name ?? "client";
    const saved = await saveOnboarding(actor, {
      cas,
      casFile: storedAs(casUpload, `CAS ${who} ${cas.valuationDate ?? ""}.pdf`),
      passwordProtected,
      report,
      reportFile: storedAs(reportUpload, `Advisory report ${who}.pdf`),
      advisorId,
      phone: null,
      kind,
      newerCas: accepted ? false : newerThan(report),
      asReported: accepted && asReason ? { reason: asReason, points: accepted } : null,
    });
    revalidatePath("/clients");
    revalidatePath("/");
    const d = (await run((tx) => listDraftPlans(tx, { planId: saved.planId })))[0];
    return {
      outcome: "ONBOARDED",
      message: [
        accepted ? `Onboarded with the report as it is: ${accepted.length} difference(s) from the CAS accepted.` : null,
        saved.kind === "ADDITIONAL"
          ? `Additional investment${report.freshMoney ? ` of ₹${report.freshMoney.toLocaleString("en-IN")}` : ""}: a draft tranche to add to the active plan.`
          : saved.created ? "New client created." : "Existing client: the report is a new draft plan (approving replaces the current plan).",
        saved.itemsNeedingReview ? `${saved.itemsNeedingReview} plan line(s) need a fund picked.` : null,
        ...saved.warnings,
      ].filter(Boolean).join(" "),
      problems: [], usedClaude, corrections, newerCas: accepted ? false : newerThan(report), accepted: accepted?.length,
      draft: d ? { sells: d.sells, buys: d.buys, sipLines: d.sip_lines, keeps: d.keeps, questions: d.open_questions, toCheck: d.needs_review } : undefined,
      clientId: saved.clientId, clientName: saved.clientName, clientCode: saved.clientCode, planId: saved.planId, created: saved.created,
    };
  } catch (e) {
    if (!(e instanceof AppError)) logServerError("bulk-onboard:pair", e);
    return fail("FAILED", toUserMessage(e));
  }
}
