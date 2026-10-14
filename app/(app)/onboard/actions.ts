"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { num, runAction, str, type ActionResult } from "@/lib/actions";
import { casPasswordTemplate, passwordCandidates } from "@/lib/cas/password";
import { readCasPdf, readReportDetailed, readReportPdf } from "@/lib/cas/reader";
import { fileNamePasswords } from "@/lib/cas/password";
import { objectPath, uploadAsUser } from "@/lib/storage";
import { reportAiConfigured } from "@/lib/integrations/report-ai";
import type { AdvisoryReportParse } from "@/lib/parsers/advisory-report";
import { createNewInvestor, newInvestorMessage, newInvestorPlan, previewNewInvestor } from "@/services/onboarding";
import { resolveWithClaude } from "@/services/report-resolve";
import { AppError } from "@/lib/errors";
import { ALL_ROLES } from "@/lib/server";
import { requireActorForAction } from "@/lib/auth/session";
import { prepareUpload } from "@/lib/storage";
import { knownClientPhones } from "@/services/cas-intake";
import { decideReportKind, problemsMessage, type ReportKindChoice } from "@/services/onboarding";
import { checkAdvisor, hasActivePlanForPan, onboardingTx, saveOnboarding } from "./save";

/**
 * Onboard from the CAS + the paid advisory report. Passwords (typed or built
 * from the template) live only in this request's memory.
 */
export async function onboardAction(_p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  let target = "";
  const res = await runAction("onboard", async () => {
    const actor = await requireActorForAction(ALL_ROLES);
    const advisorId = str(fd, "advisor_id") || null;
    await checkAdvisor(actor, advisorId);
    const casFile = await prepareUpload(fd.get("cas") as File | null);
    const reportFile = await prepareUpload(fd.get("report") as File | null);
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
    const { parsed: cas, passwordProtected } = await readCasPdf(casFile.bytes, candidates);

    const read = await readReportPdf(reportFile.bytes, candidates);
    const fresh = num(fd, "fresh_money");
    const report = fresh && fresh > 0 ? { ...read, freshMoney: fresh } : read;
    const choiceRaw = str(fd, "report_kind");
    const choice: ReportKindChoice = choiceRaw === "FULL" || choiceRaw === "ADDITIONAL" ? choiceRaw : "AUTO";
    const decided = decideReportKind(cas, report, { choice, hasActivePlan: await hasActivePlanForPan(actor, cas.investor.pan) });
    if (decided.problems.length) throw new AppError(problemsMessage(decided.problems));

    const out = await saveOnboarding(actor, { cas, casFile, passwordProtected, report, reportFile, advisorId, phone: mobile, kind: decided.kind });
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
    const reportFile = await prepareUpload(fd.get("report") as File | null);
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
