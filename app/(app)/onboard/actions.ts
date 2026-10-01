"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { runAction, str, type ActionResult } from "@/lib/actions";
import { casPasswordTemplate, passwordCandidates } from "@/lib/cas/password";
import { readCasPdf, readReportPdf } from "@/lib/cas/reader";
import { AppError } from "@/lib/errors";
import { ALL_ROLES } from "@/lib/server";
import { requireActorForAction } from "@/lib/auth/session";
import { prepareUpload } from "@/lib/storage";
import { knownClientPhones } from "@/services/cas-intake";
import { checkAdvisor, onboardingTx, saveOnboarding } from "./save";

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

    const report = await readReportPdf(reportFile.bytes, candidates);

    const out = await saveOnboarding(actor, { cas, casFile, passwordProtected, report, reportFile, advisorId, phone: mobile });
    target = `/clients/${out.clientId}/plans/${out.planId}?onboarded=${out.created ? "new" : "existing"}`;
  });
  if (!res.ok) return res;
  revalidatePath("/clients");
  redirect(target);
}
