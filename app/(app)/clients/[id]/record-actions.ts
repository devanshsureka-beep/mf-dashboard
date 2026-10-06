"use server";

import { revalidatePath } from "next/cache";
import { optStr, reqNum, reqStr, runAction, type ActionResult } from "@/lib/actions";
import { actionTx, ADVISORY_ROLES } from "@/lib/server";
import { objectPath, prepareUpload, uploadAsUser } from "@/lib/storage";
import { addAgreement, addPayment, refundPayment, saveReportNotes, setAgreementStatus, validateAgreement } from "@/services/client-record";
import { registerDocument } from "@/services/documents";

const refresh = (clientId: string) => revalidatePath(`/clients/${clientId}`);

/** Record an agreement; the signed copy (optional) is stored as a client document. */
export async function addAgreementAction(clientId: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction("addAgreement", async () => {
    const input = {
      agreementType: reqStr(fd, "agreement_type", "Type"), title: reqStr(fd, "title", "Title"), referenceNo: optStr(fd, "reference_no"),
      signedOn: optStr(fd, "signed_on"), validFrom: optStr(fd, "valid_from"), validTo: optStr(fd, "valid_to"),
      status: optStr(fd, "status") ?? "SIGNED", notes: optStr(fd, "notes"),
    };
    validateAgreement(input); // before the file is stored
    const f = fd.get("file");
    const file = f instanceof File && f.size > 0 ? await prepareUpload(f) : null;
    const path = file ? objectPath(clientId, "OTHER", file) : null;
    if (file && path) await uploadAsUser(path, file);
    // The document record and the agreement are saved together.
    await actionTx(async (tx, actor) => {
      const documentId = file && path ? await registerDocument(tx, actor.id, {
        clientId, type: "OTHER", filePath: path, fileName: file.fileName, mimeType: file.mimeType, sizeBytes: file.size,
        sha256: file.sha256, description: `Agreement: ${input.title}`,
      }) : null;
      await addAgreement(tx, actor, clientId, { ...input, documentId });
    });
    refresh(clientId);
    return file ? "Agreement recorded with its signed copy." : "Agreement recorded.";
  });
}

export async function setAgreementStatusAction(clientId: string, agreementId: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction("setAgreementStatus", async () => {
    await actionTx((tx) => setAgreementStatus(tx, agreementId, reqStr(fd, "status", "Status"), reqStr(fd, "reason", "Reason")));
    refresh(clientId);
    return "Agreement updated.";
  });
}

export async function addPaymentAction(clientId: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction("addPayment", async () => {
    await actionTx((tx, actor) => addPayment(tx, actor, clientId, {
      amount: reqNum(fd, "amount", "Amount"), paidOn: reqStr(fd, "paid_on", "Payment date"),
      periodFrom: optStr(fd, "period_from"), periodTo: optStr(fd, "period_to"), planName: optStr(fd, "plan_name"),
      mode: reqStr(fd, "mode", "Mode"), reference: optStr(fd, "reference"), notes: optStr(fd, "notes"),
    }));
    refresh(clientId);
    return "Premium payment recorded.";
  });
}

export async function refundPaymentAction(clientId: string, paymentId: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction("refundPayment", async () => {
    await actionTx((tx, actor) => refundPayment(tx, actor, paymentId, reqStr(fd, "reason", "Reason")), { roles: ["ADMIN"] });
    refresh(clientId);
    return "Payment marked refunded.";
  });
}

export async function saveReportNotesAction(clientId: string, month: string, _p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction("saveReportNotes", async () => {
    await actionTx((tx, actor) => saveReportNotes(tx, actor, clientId, month, {
      summary: optStr(fd, "summary"), outlook: optStr(fd, "outlook"), actions: optStr(fd, "actions"),
    }), { roles: ADVISORY_ROLES });
    revalidatePath(`/clients/${clientId}/report`);
    return "Report notes saved.";
  });
}

