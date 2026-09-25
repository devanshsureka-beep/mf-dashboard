/**
 * Read a CAS PDF: open it (trying password candidates), extract text lines and
 * parse them deterministically. Pure Node: no Next.js, no network.
 */
import { extractPdfLines, findWorkingPassword, PdfPasswordError } from "@/lib/pdf/text";
import { CasParseError, parseCasLines, type CasParseOutput } from "@/lib/parsers/cas";
import { AppError } from "@/lib/errors";

export interface CasReadResult {
  parsed: CasParseOutput;
  passwordProtected: boolean;
}

export async function readCasPdf(bytes: Uint8Array, candidates: string[]): Promise<CasReadResult> {
  let password: string | null;
  try {
    password = await findWorkingPassword(bytes, candidates);
  } catch (e) {
    if (e instanceof PdfPasswordError) {
      throw new AppError("Could not open the PDF: none of the known passwords worked. Enter the client's mobile number or the password.");
    }
    throw new AppError("The file could not be read as a PDF.");
  }
  let lines: string[];
  try {
    lines = await extractPdfLines(bytes, password);
  } catch {
    throw new AppError("The PDF opened but its text could not be read.");
  }
  try {
    return { parsed: parseCasLines(lines), passwordProtected: password !== null };
  } catch (e) {
    if (e instanceof CasParseError) throw new AppError(`This does not look like a KFintech/CAMS consolidated CAS: ${e.message}`);
    throw e;
  }
}
