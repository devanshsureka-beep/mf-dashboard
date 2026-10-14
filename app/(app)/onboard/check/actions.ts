"use server";

import { str } from "@/lib/actions";
import { readCasAnyPdf } from "@/lib/integrations/cas-ai";
import { casPasswordTemplate, passwordCandidates } from "@/lib/cas/password";
import { readReportDetailed } from "@/lib/cas/reader";
import { reportAiConfigured } from "@/lib/integrations/report-ai";
import { resolveWithClaude } from "@/services/report-resolve";
import { documentChecks, type DocumentCheck } from "@/lib/domain/document-checks";
import type { PlanItemDraft, SipItemDraft } from "@/lib/domain/report-plan";
import { AppError, logServerError, toUserMessage } from "@/lib/errors";
import { actionTx } from "@/lib/server";
import { fileFromForm } from "@/lib/storage";
import { findClientByPan, knownClientPhones } from "@/services/cas-intake";
import { previewOnboarding } from "@/services/onboarding";

export type CheckResult =
  | { ok: false; error: string }
  | {
      ok: true;
      canOnboard: boolean;
      investor: { name: string | null; pan: string | null; email: string | null; mobile: string | null };
      existingClient: { id: string; code: string; name: string } | null;
      cas: { source: string; valuationDate: string | null; funds: number; total: number; transactions: number };
      report: { clientName: string | null; prepared: string | null; risk: string | null; goal: string | null; currentValue: number | null };
      checks: DocumentCheck[];
      items: PlanItemDraft[];
      sips: SipItemDraft[];
    };

/**
 * Read a CAS + advisory report and show exactly what onboarding would do.
 * Read-only: nothing is stored (files stay in memory for this request).
 */
export async function checkDocumentsAction(fd: FormData): Promise<CheckResult> {
  try {
    const casFile = await fileFromForm(fd, "cas");
    const reportFile = await fileFromForm(fd, "report");
    if (casFile.mimeType !== "application/pdf" || reportFile.mimeType !== "application/pdf") throw new AppError("Both files must be PDFs.");
    const phones = await actionTx((tx) => knownClientPhones(tx));
    const candidates = passwordCandidates({
      template: casPasswordTemplate(),
      explicit: [str(fd, "password") || null, str(fd, "mobile").replace(/\D/g, "").slice(-10) || null],
      fileName: casFile.fileName,
      phones,
    });
    const deadline = Date.now() + 270_000; // the page allows 300 s
    const { parsed: cas } = await readCasAnyPdf(casFile.bytes, candidates, { timeoutMs: Math.min(200_000, deadline - Date.now()) });
    // Same as onboarding: the built-in reader, then Claude for a report it cannot read or tie out.
    const read = await readReportDetailed(reportFile.bytes, candidates);
    let report = read.report;
    let preview = report ? previewOnboarding(cas, report) : null;
    if ((!report || preview!.problems.length) && reportAiConfigured()) {
      const r = await resolveWithClaude({
        cas, reportPdf: reportFile.bytes, draft: report, readerError: read.error,
        problems: preview?.problems ?? [`The built-in reader could not read the report: ${read.error}`], deadline, reportFileName: reportFile.fileName,
      });
      if (r.status === "WRONG_PAIR") throw new AppError(`${r.message} Use this client's own report with this CAS.`);
      if (r.status === "RESOLVED") report = r.report;
      preview = report ? previewOnboarding(cas, report) : null;
    }
    if (!report || !preview) throw new AppError(`The advisory report could not be read: ${read.error ?? "unknown layout"}`);
    const existing = await actionTx((tx) => findClientByPan(tx, cas.investor.pan));
    // Summary straight from the CAS (also when the documents do not match).
    const held = cas.schemes.filter((x) => (x.closingUnits ?? 0) > 0.0005 && (!cas.investor.pan || !x.pan || x.pan === cas.investor.pan));
    return {
      ok: true,
      canOnboard: preview.problems.length === 0,
      investor: cas.investor,
      existingClient: existing ? { id: existing.id, code: existing.client_code, name: existing.full_name } : null,
      cas: {
        source: cas.source,
        valuationDate: cas.valuationDate,
        funds: held.length,
        total: Math.round(held.reduce((t, h) => t + (h.marketValue ?? 0), 0) * 100) / 100,
        transactions: cas.schemes.reduce((t, s) => t + s.transactions.length, 0),
      },
      report: { clientName: report.clientName, prepared: report.preparedDate, risk: report.riskProfile, goal: report.goal, currentValue: report.currentValue },
      checks: documentChecks({ cas, report, draft: preview.draft, problems: preview.problems }),
      items: preview.draft?.items ?? [],
      sips: preview.draft?.sip_items ?? [],
    };
  } catch (e) {
    if (!(e instanceof AppError)) logServerError("checkDocuments", e);
    return { ok: false, error: toUserMessage(e) };
  }
}
