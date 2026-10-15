"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { runAction, str, type ActionResult } from "@/lib/actions";
import { fileNamePasswords } from "@/lib/cas/password";
import { objectPath, uploadAsUser, fileFromForm } from "@/lib/storage";
import { reportAiConfigured } from "@/lib/integrations/report-ai";
import type { AdvisoryReportParse } from "@/lib/parsers/advisory-report";
import { createNewInvestor, isBlockingNewInvestorProblem, newInvestorMessage, newInvestorPlan, previewNewInvestor } from "@/services/onboarding";
import { resolveWithClaude } from "@/services/report-resolve";
import { AppError } from "@/lib/errors";
import { ALL_ROLES } from "@/lib/server";
import { requireActorForAction } from "@/lib/auth/session";
import { readReportDetailed } from "@/lib/cas/reader";
import { checkAdvisor, onboardingTx } from "./save";

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
        report = r.report ?? report; // Claude's best reading, for "create the draft with what was read"
      }
    }
    // "Create the draft with what was read": reading problems are accepted (with a reason), never the name / PAN.
    const asReason = str(fd, "as_reported_reason").slice(0, 500) || null;
    if (asReason && actor.role === "OPERATIONS") throw new AppError("Only an advisor or an admin can create the draft with what was read.");
    const accept = Boolean(asReason && asReason.length >= 3 && report && problems.length && !problems.some(isBlockingNewInvestorProblem));
    if (!accept && (problems.length || !report)) {
      throw new AppError(newInvestorMessage(problems) + (problems.length && !problems.some(isBlockingNewInvestorProblem) && actor.role !== "OPERATIONS"
        ? "\nTo create the draft with what was read, give a reason under More options and submit again." : ""));
    }
    if (!report) throw new AppError(newInvestorMessage(problems));
    const asReported = accept && asReason ? { reason: asReason, points: problems } : null;

    const run = onboardingTx(actor);
    const final = report;
    const client = await run((tx, a) => createNewInvestor(tx, a, { who, advisorId, report: final, asReported }));
    const path = objectPath(client.id, "ADVISORY_REPORT", reportFile);
    await uploadAsUser(path, reportFile);
    const plan = await run((tx, a) => newInvestorPlan(tx, a, {
      clientId: client.id, who, report: final, asReported,
      reportFile: { fileName: reportFile.fileName, mimeType: reportFile.mimeType, size: reportFile.size, sha256: reportFile.sha256, path },
    }));
    const out = { clientId: client.id, planId: plan.planId };
    target = `/clients/${out.clientId}/plans/${out.planId}?onboarded=new`;
  });
  if (!res.ok) return res;
  revalidatePath("/clients");
  revalidatePath("/");
  redirect(target);
}
