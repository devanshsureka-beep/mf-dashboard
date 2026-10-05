/**
 * Read a client's CAS with the built-in parser (single upload, or a CAS stored
 * earlier and never read). Same steps as Bulk CAS Upload: open with the typed
 * password, the house template, parts of the file name and known mobiles; the
 * CAS PAN must be this client's; then snapshot + reconciliation. Passwords live
 * only in this request's memory.
 */
import { casPasswordTemplate, passwordCandidates } from "@/lib/cas/password";
import { readCasPdf } from "@/lib/cas/reader";
import { AppError } from "@/lib/errors";
import { maskPan } from "@/lib/format";
import { actionTx } from "@/lib/server";
import type { StoredFile } from "@/services/cas-intake";
import { ingestParsedCas, knownClientPhones, type CasIntakeOutcome } from "@/services/cas-intake";

export async function readClientCas(args: {
  clientId: string;
  clientPan: string | null;
  bytes: Uint8Array;
  file: StoredFile;
  typedPassword: string | null;
  existingCasDocumentId?: string;
}): Promise<CasIntakeOutcome> {
  const phones = await actionTx((tx) => knownClientPhones(tx));
  const candidates = passwordCandidates({
    template: casPasswordTemplate(),
    explicit: [args.typedPassword],
    fileName: args.file.fileName,
    phones,
    fileNameParts: true,
  });
  const { parsed, passwordProtected } = await readCasPdf(args.bytes, candidates);
  const pan = parsed.investor.pan?.toUpperCase() ?? null;
  if (args.clientPan && pan && pan !== args.clientPan.toUpperCase()) {
    throw new AppError(`This CAS is for PAN ${maskPan(pan)} (${parsed.investor.name ?? "another investor"}), not this client.`);
  }
  return actionTx((tx, actor) => ingestParsedCas(tx, actor, {
    clientId: args.clientId,
    file: args.file,
    parsed,
    passwordProtected,
    existingCasDocumentId: args.existingCasDocumentId,
  }));
}
