"use server";

import { revalidatePath } from "next/cache";
import { readCasAnyPdf } from "@/lib/integrations/cas-ai";
import { redirect } from "next/navigation";
import { num, runAction, str, type ActionResult } from "@/lib/actions";
import { casPasswordTemplate, passwordCandidates } from "@/lib/cas/password";

import { fileNamePasswords } from "@/lib/cas/password";
import { objectPath, uploadAsUser, fileFromForm } from "@/lib/storage";
import { reportAiConfigured } from "@/lib/integrations/report-ai";
import type { AdvisoryReportParse } from "@/lib/parsers/advisory-report";
import { createNewInvestor, newInvestorMessage, newInvestorPlan, previewNewInvestor } from "@/services/onboarding";
import { resolveWithClaude } from "@/services/report-resolve";
import { AppError } from "@/lib/errors";
import { ALL_ROLES } from "@/lib/server";
import { requireActorForAction } from "@/lib/auth/session";
import { knownClientPhones } from "@/services/cas-intake";
import { checkDocumentsBelongTogether, decideReportKind, problemsMessage, type ReportKindChoice } from "@/services/onboarding";
import { readReportDetailed } from "@/lib/cas/reader";
import { checkAdvisor, hasActivePlanForPan, onboardingTx, saveOnboarding } from "./save";

/**
 * Onboard from the CAS + the paid advisory report. Passwords (typed or built
 * from the template) live only in this request's memory.
 */
export async function onboardAction(_p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  let target = "";
  const deadline = Date.now() + 250_000; // the page allows 300 s; the rest is for saving
  const res = await runAction("onboard", async () => {
    const actor = await requireActorForAction(ALL_ROLES);
    const advisorId = str(fd, "advisor_id") || null;
    await checkAdvisor(actor, advisorId);
    const casFile = await fileFromForm(fd, "cas");
    const reportFile = await fileFromForm(fd, "report");
    if (casFile.mimeType !== "application/pdf" || reportFile.mimeType !== "application/pdf") throw new AppError("Both files must be PDFs.");
    const secret = str(fd, "password") || null;
    const mobile = str(fd, "mobile").replace(/\D/g, "").slice(-10) || null;

    const phones = await onboardingTx(actor)((tx) => knownClientPhones(tx));
    const candidates = passwordCandidates({
      template: casPasswordTemplate(),
      explicit: [secret, mobile],
      fileName: casFile.fileName,
      phones,
    });
    // A picture-only CAS is read by Claude; the report gets the rest of the time.
    const { parsed: cas, passwordProtected } = await readCasAnyPdf(casFile.bytes, candidates, { timeoutMs: Math.min(200_000, deadline - Date.now()) });
    if (!cas.investor.pan) throw new AppError("The CAS shows no PAN, so the client cannot be identified.");

    // 1) Built-in readers (a report they cannot read, or one that is only pictures, goes to Claude below).
    const read = await readReportDetailed(reportFile.bytes, candidates);
    const fresh = num(fd, "fresh_money");
    const withFresh = (r: AdvisoryReportParse): AdvisoryReportParse => (fresh && fresh > 0 ? { ...r, freshMoney: fresh } : r);
    let report: AdvisoryReportParse | null = read.report ? withFresh(read.report) : null;
    if (report) {
      const together = checkDocumentsBelongTogether(cas, report);
      if (together.problem && report.clientName) throw new AppError(`${together.problem} Upload this client's own report with this CAS.`);
    }
    const choiceRaw = str(fd, "report_kind");
    const choice: ReportKindChoice = choiceRaw === "FULL" || choiceRaw === "ADDITIONAL" ? choiceRaw : "AUTO";
    // The CAS may be newer than the report (the client already acted on part of it): differences are asked on the plan.
    const newerCas = str(fd, "cas_kind") === "NEWER";
    const hasActivePlan = await hasActivePlanForPan(actor, cas.investor.pan);
    const check = (r: AdvisoryReportParse) => decideReportKind(cas, withFresh(r), { choice, hasActivePlan, newerCas });
    const first = report ? check(report) : null;
    let kind = first?.kind ?? "FULL";
    let problems = first ? first.problems : [`The built-in reader could not read the report: ${read.error}`];

    // 2) Claude for what did not reconcile, as in bulk onboarding: points still open go back to Claude,
    //    and every answer passes the same CAS tie-out.
    let usedClaude = false;
    if (problems.length && reportAiConfigured()) {
      const r = await resolveWithClaude({
        cas, reportPdf: reportFile.bytes, draft: report, readerError: read.error, problems, deadline, reportFileName: reportFile.fileName, check,
      });
      usedClaude = r.rounds > 0;
      if (r.status === "WRONG_PAIR") throw new AppError(`${r.message} Upload this client's own report with this CAS.`);
      if (r.status === "RESOLVED") {
        report = withFresh(r.report);
        kind = r.kind;
        problems = [];
      } else {
        problems = r.problems.length ? r.problems : problems;
        if (r.error && !usedClaude) problems = [`Claude could not help: ${r.error}`, ...problems];
      }
    }
    if (problems.length || !report) {
      // A CAS dated after the report: the client has probably acted on it already.
      const reportDate = report ? report.valuationDate ?? report.casPeriod?.to ?? report.preparedDate : null;
      const hint = !newerCas && reportDate && cas.valuationDate && cas.valuationDate > reportDate
        ? [`This CAS (${cas.valuationDate}) is newer than the report (${reportDate}). If the client already acted on part of the report, choose "Which CAS is this? → A newer CAS": each difference then becomes a question on the plan instead of blocking.`]
        : [];
      const lead = usedClaude ? ["Claude re-read the report, but these points still do not match the CAS:"] : [];
      throw new AppError(problemsMessage([...hint, ...lead, ...problems]));
    }

    const out = await saveOnboarding(actor, { cas, casFile, passwordProtected, report, reportFile, advisorId, phone: mobile, kind, newerCas });
    target = `/clients/${out.clientId}/plans/${out.planId}?onboarded=${out.created ? "new" : "existing"}`;
  });
  if (!res.ok) return res;
  revalidatePath("/clients");
  redirect(target);
}

/**
 * A new investor with no mutual funds yet (no CAS): the client from the details
 * typed in, the plan from the report alone (buys and SIP starts, fresh money).
 * Lines the built-in reader cannot place go to Claude when it is set up.
 */
export async function onboardNewInvestorAction(_p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  let target = "";
  const res = await runAction("onboardNewInvestor", async () => {
    const actor = await requireActorForAction(ALL_ROLES);
    const advisorId = str(fd, "advisor_id") || null;
    await checkAdvisor(actor, advisorId);
    const reportFile = await fileFromForm(fd, "report");
    if (reportFile.mimeType !== "application/pdf") throw new AppError("The report must be a PDF.");
    const who = {
      fullName: str(fd, "full_name"),
      pan: str(fd, "pan").toUpperCase(),
      phone: str(fd, "mobile").replace(/\D/g, "").slice(-10) || null,
      email: str(fd, "email") || null,
    };
    const candidates = [str(fd, "password"), ...fileNamePasswords(reportFile.fileName)].filter(Boolean);
    const read = await readReportDetailed(reportFile.bytes, candidates);
    let report: AdvisoryReportParse | null = read.report;
    let problems = report ? previewNewInvestor(report, who).problems : [`The built-in reader could not read the report: ${read.error}`];
    // Only the report's own lines can be wrong here (the name / PAN are typed): Claude re-reads it.
    const readingProblem = !report || problems.some((p) => !/^Enter |is for "|already holds mutual funds|does not have: onboard/.test(p));
    if (problems.length && readingProblem && reportAiConfigured()) {
      const r = await resolveWithClaude({
        cas: null, expectedName: who.fullName, reportPdf: reportFile.bytes, draft: report, readerError: read.error, problems,
        deadline: Date.now() + 240_000, reportFileName: reportFile.fileName,
        check: (x) => ({ kind: "FULL", problems: previewNewInvestor(x, who).problems }),
      });
      if (r.status === "RESOLVED") {
        report = r.report;
        problems = [];
      } else if (r.status === "WRONG_PAIR") {
        problems = [r.message];
      } else {
        problems = r.problems;
      }
    }
    if (problems.length || !report) throw new AppError(newInvestorMessage(problems));

    const run = onboardingTx(actor);
    const final = report;
    const client = await run((tx, a) => createNewInvestor(tx, a, { who, advisorId, report: final }));
    const path = objectPath(client.id, "ADVISORY_REPORT", reportFile);
    await uploadAsUser(path, reportFile);
    const plan = await run((tx, a) => newInvestorPlan(tx, a, {
      clientId: client.id, who, report: final,
      reportFile: { fileName: reportFile.fileName, mimeType: reportFile.mimeType, size: reportFile.size, sha256: reportFile.sha256, path },
    }));
    const out = { clientId: client.id, planId: plan.planId };
    target = `/clients/${out.clientId}/plans/${out.planId}?onboarded=new`;
  });
  if (!res.ok) return res;
  revalidatePath("/clients");
  redirect(target);
}
