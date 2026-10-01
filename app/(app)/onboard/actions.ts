"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { runAction, str, type ActionResult } from "@/lib/actions";
import { casPasswordTemplate, passwordCandidates } from "@/lib/cas/password";
import { readCasPdf, readReportPdf } from "@/lib/cas/reader";
import { AppError } from "@/lib/errors";
import { ALL_ROLES } from "@/lib/server";
import { requireActorForAction } from "@/lib/auth/session";
import { withSystemTx, withUserTx, type Actor, type Tx } from "@/lib/db/tx";
import { objectPath, prepareUpload, uploadAsUser } from "@/lib/storage";
import { knownClientPhones } from "@/services/cas-intake";
import { ensureClientFromDocuments, onboardFromDocuments } from "@/services/onboarding";

/**
 * Onboard from the CAS + the paid advisory report. Passwords (typed or built
 * from the template) live only in this request's memory.
 */
/**
 * Advisors and admins onboard under their own database permissions. Operations
 * may onboard too (business decision 2026-10-01): their database role cannot
 * create clients or plans, so this one fully-checked flow runs as the trusted
 * server for them, labelled with their email in the audit log, and the plan
 * still opens as a DRAFT that an advisor or admin approves.
 */
function onboardingTx(actor: Actor) {
  return <T>(fn: (tx: Tx, actor: Actor) => Promise<T>): Promise<T> =>
    actor.role === "OPERATIONS"
      ? withSystemTx(`onboarding:${actor.email}`, (tx) => fn(tx, actor))
      : withUserTx(actor, (tx) => fn(tx, actor));
}

export async function onboardAction(_p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  let target = "";
  const res = await runAction("onboard", async () => {
    const actor = await requireActorForAction(ALL_ROLES);
    const run = onboardingTx(actor);
    const advisorId = str(fd, "advisor_id") || null;
    if (actor.role === "OPERATIONS") {
      if (!advisorId) throw new AppError("Choose the primary advisor for this client.");
      const ok = await run((tx) => tx<{ id: string }[]>`
        select id from public.profiles where id = ${advisorId} and role in ('ADVISOR', 'ADMIN') and is_active`);
      if (!ok[0]) throw new AppError("Choose an active advisor.");
    }
    const casFile = await prepareUpload(fd.get("cas") as File | null);
    const reportFile = await prepareUpload(fd.get("report") as File | null);
    if (casFile.mimeType !== "application/pdf" || reportFile.mimeType !== "application/pdf") throw new AppError("Both files must be PDFs.");
    const secret = str(fd, "password") || null;
    const mobile = str(fd, "mobile").replace(/\D/g, "").slice(-10) || null;

    const phones = await run((tx) => knownClientPhones(tx));
    const candidates = passwordCandidates({
      template: casPasswordTemplate(),
      explicit: [secret, mobile],
      fileName: casFile.fileName,
      phones,
    });
    const { parsed: cas, passwordProtected } = await readCasPdf(casFile.bytes, candidates);

    const report = await readReportPdf(reportFile.bytes, candidates);

    const client = await run((tx, a) => ensureClientFromDocuments(tx, a, { cas, report, advisorId, phone: mobile }));

    const casPath = objectPath(client.id, "CAS", casFile);
    const reportPath = objectPath(client.id, "ADVISORY_REPORT", reportFile);
    await uploadAsUser(casPath, casFile);
    await uploadAsUser(reportPath, reportFile);

    const out = await run((tx, a) => onboardFromDocuments(tx, a, {
      clientId: client.id,
      cas,
      casFile: { fileName: casFile.fileName, mimeType: casFile.mimeType, size: casFile.size, sha256: casFile.sha256, path: casPath, passwordProtected },
      report,
      reportFile: { fileName: reportFile.fileName, mimeType: reportFile.mimeType, size: reportFile.size, sha256: reportFile.sha256, path: reportPath },
    }));
    target = `/clients/${out.clientId}/plans/${out.planId}?onboarded=${client.created ? "new" : "existing"}`;
  });
  if (!res.ok) return res;
  revalidatePath("/clients");
  redirect(target);
}
