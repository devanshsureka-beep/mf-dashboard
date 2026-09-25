"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { runAction, str, type ActionResult } from "@/lib/actions";
import { casPasswordTemplate, passwordCandidates } from "@/lib/cas/password";
import { readCasPdf } from "@/lib/cas/reader";
import { AppError } from "@/lib/errors";
import { parseAdvisoryReportLines, ReportParseError } from "@/lib/parsers/advisory-report";
import { extractPdfLines, findWorkingPassword, PdfPasswordError } from "@/lib/pdf/text";
import { ADVISORY_ROLES, actionTx } from "@/lib/server";
import { objectPath, prepareUpload, uploadAsUser } from "@/lib/storage";
import { knownClientPhones } from "@/services/cas-intake";
import { ensureClientFromDocuments, onboardFromDocuments } from "@/services/onboarding";

/**
 * Onboard from the CAS + the paid advisory report. Passwords (typed or built
 * from the template) live only in this request's memory.
 */
export async function onboardAction(_p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  let target = "";
  const res = await runAction("onboard", async () => {
    const casFile = await prepareUpload(fd.get("cas") as File | null);
    const reportFile = await prepareUpload(fd.get("report") as File | null);
    if (casFile.mimeType !== "application/pdf" || reportFile.mimeType !== "application/pdf") throw new AppError("Both files must be PDFs.");
    const secret = str(fd, "password") || null;
    const mobile = str(fd, "mobile").replace(/\D/g, "").slice(-10) || null;

    const phones = await actionTx((tx) => knownClientPhones(tx), { roles: ADVISORY_ROLES });
    const candidates = passwordCandidates({
      template: casPasswordTemplate(),
      explicit: [secret, mobile],
      fileName: casFile.fileName,
      phones,
    });
    const { parsed: cas, passwordProtected } = await readCasPdf(casFile.bytes, candidates);

    let report;
    try {
      const pw = await findWorkingPassword(reportFile.bytes, candidates);
      report = parseAdvisoryReportLines(await extractPdfLines(reportFile.bytes, pw));
    } catch (e) {
      if (e instanceof PdfPasswordError) throw new AppError("The advisory report is password protected and none of the passwords worked.");
      if (e instanceof ReportParseError) throw new AppError(`The advisory report could not be read: ${e.message}`);
      throw e;
    }

    const client = await actionTx(
      (tx, actor) => ensureClientFromDocuments(tx, actor, { cas, report, advisorId: str(fd, "advisor_id") || null, phone: mobile }),
      { roles: ADVISORY_ROLES },
    );

    const casPath = objectPath(client.id, "CAS", casFile);
    const reportPath = objectPath(client.id, "ADVISORY_REPORT", reportFile);
    await uploadAsUser(casPath, casFile);
    await uploadAsUser(reportPath, reportFile);

    const out = await actionTx((tx, actor) => onboardFromDocuments(tx, actor, {
      clientId: client.id,
      cas,
      casFile: { fileName: casFile.fileName, mimeType: casFile.mimeType, size: casFile.size, sha256: casFile.sha256, path: casPath, passwordProtected },
      report,
      reportFile: { fileName: reportFile.fileName, mimeType: reportFile.mimeType, size: reportFile.size, sha256: reportFile.sha256, path: reportPath },
    }), { roles: ADVISORY_ROLES });
    target = `/clients/${out.clientId}/plans/${out.planId}?onboarded=${client.created ? "new" : "existing"}`;
  });
  if (!res.ok) return res;
  revalidatePath("/clients");
  redirect(target);
}
