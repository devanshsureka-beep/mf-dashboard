/**
 * Read a client's CAS with the built-in parser (single upload, or a CAS stored
 * earlier and never read). Same steps as Bulk CAS Upload: open with the typed
 * password, the house template, parts of the file name and known mobiles; the
 * CAS PAN must be this client's; then snapshot + reconciliation. Passwords live
 * only in this request's memory.
 */
import { casPasswordTemplate, passwordCandidates } from "@/lib/cas/password";
import { readCasAnyPdf } from "@/lib/integrations/cas-ai";
import { AppError } from "@/lib/errors";
import { maskPan } from "@/lib/format";
import { actionTx } from "@/lib/server";
import type { StoredFile } from "@/services/cas-intake";
import { casMatchesClient, claimPan, findClientByPan, ingestParsedCas, knownClientPhones, type CasIntakeOutcome } from "@/services/cas-intake";

/** The CAS is someone else's: never stored on this client (not even for the n8n reader). */
export class CasIdentityError extends AppError {}

export async function readClientCas(args: {
  clientId: string;
  clientPan: string | null;
  /** For a client without a PAN: the CAS must show their mobile and name before its PAN is taken. */
  client?: { phone: string | null; full_name: string };
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
  const { parsed, passwordProtected } = await readCasAnyPdf(args.bytes, candidates, { timeoutMs: 220_000 }); // leaves time to save within 300 s
  const pan = parsed.investor.pan?.toUpperCase() ?? null;
  if (args.clientPan && pan && pan !== args.clientPan.toUpperCase()) {
    throw new CasIdentityError(`This CAS is for PAN ${maskPan(pan)} (${parsed.investor.name ?? "another investor"}), not this client.`);
  }
  return actionTx(async (tx, actor) => {
    // Onboarded without a PAN (from the report alone): the first CAS gives it, unless another client has it.
    if (!args.clientPan && pan) {
      const other = await findClientByPan(tx, pan);
      if (other && other.id !== args.clientId) throw new CasIdentityError(`This CAS is for PAN ${maskPan(pan)}, which is ${other.full_name} (${other.client_code}).`);
      if (!other) {
        if (!args.client || !casMatchesClient(parsed.investor, args.client)) {
          throw new CasIdentityError(`This CAS is for ${parsed.investor.name ?? "another investor"} (PAN ${maskPan(pan)}); its mobile number and name do not both match this client.`);
        }
        // Another client (perhaps one this user cannot see) may hold the PAN: then it is not this client's CAS.
        try {
          await claimPan(tx, args.clientId, pan);
        } catch {
          throw new CasIdentityError(`This CAS is for PAN ${maskPan(pan)}, which another client already has.`);
        }
      }
    }
    return ingestParsedCas(tx, actor, {
    clientId: args.clientId,
    file: args.file,
    parsed,
    passwordProtected,
    existingCasDocumentId: args.existingCasDocumentId,
    });
  });
}
