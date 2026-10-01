"use server";

import { revalidatePath } from "next/cache";
import { str } from "@/lib/actions";
import { casPasswordTemplate, fileNamePasswords, passwordCandidates } from "@/lib/cas/password";
import { identifyPdf, readCasPdf, readReportDetailed } from "@/lib/cas/reader";
import { AppError, logServerError, toUserMessage } from "@/lib/errors";
import { reportAiConfigured } from "@/lib/integrations/report-ai";
import { requireActorForAction } from "@/lib/auth/session";
import { ALL_ROLES } from "@/lib/server";
import { maskPan } from "@/lib/format";
import { prepareUpload, type PreparedFile } from "@/lib/storage";
import type { AdvisoryReportParse } from "@/lib/parsers/advisory-report";
import { findClientByPan, knownClientPhones } from "@/services/cas-intake";
import { findDuplicateDocument } from "@/services/portfolio";
import { checkDocumentsBelongTogether, previewOnboarding } from "@/services/onboarding";
import { resolveWithClaude } from "@/services/report-resolve";
import { checkAdvisor, onboardingTx, saveOnboarding } from "../save";

/**
 * Bulk onboarding from one folder of CAS + report PDFs with no naming rule.
 * Step 1 reads each file (what it is, whose it is); step 2 onboards one
 * CAS + report pair per call. CAS passwords are tried from the file name,
 * the house template and known mobiles, kept in memory only, and stripped
 * from the stored file names. Request bodies are never logged.
 */

export interface BulkFileInfo {
  fileName: string;
  kind: "CAS" | "REPORT" | "LOCKED" | "UNREADABLE";
  name: string | null;
  panMasked: string | null;
  casDate: string | null;
  /** Report: the built-in reader understood its layout. */
  readerOk: boolean;
  existingClient: string | null;
  message: string;
}


async function candidatesFor(actorRun: ReturnType<typeof onboardingTx>, fileName: string): Promise<string[]> {
  const phones = await actorRun((tx) => knownClientPhones(tx));
  return passwordCandidates({ template: casPasswordTemplate(), fileName, phones, fileNameParts: true });
}

export async function identifyBulkFileAction(fd: FormData): Promise<BulkFileInfo> {
  const f = fd.get("file");
  const fileName = f instanceof File ? f.name : "file";
  const base: BulkFileInfo = { fileName, kind: "UNREADABLE", name: null, panMasked: null, casDate: null, readerOk: false, existingClient: null, message: "" };
  try {
    const actor = await requireActorForAction(ALL_ROLES);
    const run = onboardingTx(actor);
    const file = await prepareUpload(f as File | null);
    if (file.mimeType !== "application/pdf") return { ...base, message: "Not a PDF." };
    const id = await identifyPdf(file.bytes, await candidatesFor(run, file.fileName));
    switch (id.kind) {
      case "CAS": {
        const existing = await run((tx) => findClientByPan(tx, id.cas.investor.pan));
        return {
          ...base, kind: "CAS", name: id.cas.investor.name, panMasked: maskPan(id.cas.investor.pan), casDate: id.cas.valuationDate,
          existingClient: existing ? `${existing.full_name} (${existing.client_code})` : null,
          message: id.cas.investor.pan ? "" : "This CAS shows no PAN, so the client cannot be identified.",
        };
      }
      case "REPORT":
        return {
          ...base, kind: "REPORT", name: id.nameGuess, readerOk: id.report !== null,
          message: id.report ? "" : `Layout not known to the built-in reader${reportAiConfigured() ? "; Claude will read it" : ""}.`,
        };
      case "LOCKED":
        return { ...base, kind: "LOCKED", message: "Password protected, and no part of the file name opened it. Rename the file to include the password." };
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

export interface BulkOnboardRow {
  outcome: "ONBOARDED" | "NEEDS_REVIEW" | "ALREADY" | "FAILED";
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

    const casUpload = await prepareUpload(fd.get("cas") as File | null);
    const reportUpload = await prepareUpload(fd.get("report") as File | null);
    if (casUpload.mimeType !== "application/pdf" || reportUpload.mimeType !== "application/pdf") return fail("FAILED", "Both files must be PDFs.");

    const casCandidates = await candidatesFor(run, casUpload.fileName);
    const { parsed: cas, passwordProtected } = await readCasPdf(casUpload.bytes, casCandidates);
    if (!cas.investor.pan) return fail("FAILED", "The CAS shows no PAN, so the client cannot be identified.");

    // Same report already onboarded for this client: nothing to do.
    const existing = await run((tx) => findClientByPan(tx, cas.investor.pan));
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
    let report: AdvisoryReportParse | null = read.report;
    if (report) {
      const together = checkDocumentsBelongTogether(cas, report);
      if (together.problem && report.clientName) return fail("FAILED", `${together.problem} Pair this CAS with the right report.`);
    }
    const problems = report ? previewOnboarding(cas, report).problems : [`The built-in reader could not read the report: ${read.error}`];
    let usedClaude = false;
    let corrections: string[] = [];

    // 2) Claude for what did not reconcile (points still open go back to Claude);
    //    every answer passes the same CAS tie-out.
    if (problems.length) {
      if (!reportAiConfigured()) {
        return fail("NEEDS_REVIEW", "The report does not reconcile with the CAS, and the Claude reader is not set up.", { problems });
      }
      const r = await resolveWithClaude({ cas, reportPdf: reportUpload.bytes, draft: report, readerError: read.error, problems, deadline, reportFileName: reportUpload.fileName });
      usedClaude = r.rounds > 0;
      corrections = r.corrections;
      if (r.status === "WRONG_PAIR") return fail("FAILED", `${r.message} Pair this CAS with the right report.`, { usedClaude, corrections });
      if (r.status === "OPEN") {
        return fail("NEEDS_REVIEW", r.error && !usedClaude
          ? `The report does not reconcile, and Claude could not help: ${r.error}`
          : `Even after Claude re-read the report${r.rounds > 1 ? ` (${r.rounds} rounds)` : ""}, these points do not reconcile with the CAS.${r.error ? ` (${r.error})` : ""}`,
        { problems: r.problems, usedClaude, corrections });
      }
      report = r.report;
    }
    if (!report) return fail("FAILED", "The report could not be read.");

    const who = cas.investor.name ?? "client";
    const saved = await saveOnboarding(actor, {
      cas,
      casFile: storedAs(casUpload, `CAS ${who} ${cas.valuationDate ?? ""}.pdf`),
      passwordProtected,
      report,
      reportFile: storedAs(reportUpload, `Advisory report ${who}.pdf`),
      advisorId,
      phone: null,
    });
    revalidatePath("/clients");
    return {
      outcome: "ONBOARDED",
      message: [
        saved.created ? "New client created." : "Existing client: the report is a new draft plan.",
        saved.itemsNeedingReview ? `${saved.itemsNeedingReview} plan line(s) need a fund picked.` : null,
        ...saved.warnings,
      ].filter(Boolean).join(" "),
      problems: [], usedClaude, corrections,
      clientId: saved.clientId, clientName: saved.clientName, clientCode: saved.clientCode, planId: saved.planId, created: saved.created,
    };
  } catch (e) {
    if (!(e instanceof AppError)) logServerError("bulk-onboard:pair", e);
    return fail("FAILED", toUserMessage(e));
  }
}
