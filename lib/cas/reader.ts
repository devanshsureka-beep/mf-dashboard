/**
 * Read a CAS PDF: open it (trying password candidates), extract text lines and
 * parse them deterministically. Pure Node: no Next.js, no network.
 */
import { extractPdfLines, extractPdfPages, findWorkingPassword, pagesToLines, PdfPasswordError } from "@/lib/pdf/text";
import { CasParseError, parseCasLines, type CasParseOutput } from "@/lib/parsers/cas";
import { AppError } from "@/lib/errors";
import { ReportParseError, type AdvisoryReportParse } from "@/lib/parsers/advisory-report";
import { parseAdvisoryReportPages } from "@/lib/parsers/report";

/**
 * A PDF whose pages are pictures (scanned, or re-saved with "Microsoft Print to
 * PDF" / "Save as image") has no text to read.
 */
export function imageOnly(lines: string[]): boolean {
  const letters = lines.filter((l) => !l.startsWith("@@PAGE_BREAK")).join("").replace(/[^A-Za-z]/g, "").length;
  return letters < 40;
}

export const IMAGE_ONLY_CAS =
  "This CAS PDF has no text: its pages are pictures (it was scanned, or re-saved with \"Microsoft Print to PDF\" / \"Print → Save as PDF\"). Upload the original CAS PDF as received from CAMS / KFintech (the password-protected one from the email or the CAMS / MF Central website). Do not print or re-save it.";
export const IMAGE_ONLY_REPORT =
  "This report PDF has no text: its pages are pictures (scanned, or re-saved with \"Microsoft Print to PDF\"). Upload the original report PDF.";

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
  if (imageOnly(lines)) throw new AppError(IMAGE_ONLY_CAS);
  try {
    return { parsed: parseCasLines(lines), passwordProtected: password !== null };
  } catch (e) {
    if (e instanceof CasParseError) throw new AppError(`This does not look like a KFintech/CAMS consolidated CAS: ${e.message}`);
    throw e;
  }
}

/** Read the advisory report PDF (usually not locked; the same candidates are tried if it is). */
export async function readReportPdf(bytes: Uint8Array, candidates: string[]): Promise<AdvisoryReportParse> {
  try {
    const pw = await findWorkingPassword(bytes, candidates);
    const pages = await extractPdfPages(bytes, pw);
    if (imageOnly(pagesToLines(pages))) throw new AppError(IMAGE_ONLY_REPORT);
    return parseAdvisoryReportPages(pages);
  } catch (e) {
    if (e instanceof PdfPasswordError) throw new AppError("The advisory report is password protected and none of the passwords worked.");
    if (e instanceof ReportParseError) throw new AppError(`The advisory report could not be read: ${e.message}`);
    throw e;
  }
}

/** What an unnamed PDF from a client folder is (bulk onboarding). */
export type PdfIdentity =
  | { kind: "CAS"; cas: CasParseOutput; passwordProtected: boolean }
  | { kind: "CAS_UNREADABLE"; error: string }
  | { kind: "REPORT"; report: AdvisoryReportParse | null; error: string | null; nameGuess: string | null }
  | { kind: "LOCKED" }
  /** Pages are pictures (scanned / "Microsoft Print to PDF"): no text to tell what it is. */
  | { kind: "IMAGE_ONLY"; locked: boolean }
  | { kind: "UNREADABLE"; error: string };

const looksLikeCas = (text: string) =>
  /consolidated account statement/i.test(text) && /(cams|kfin|karvy|computer age)/i.test(text);

/** "Prepared for: Rahul Sharma" / "Client Name : Rahul Sharma" in a report the readers could not parse. */
export function guessClientName(lines: string[]): string | null {
  for (const l of lines.slice(0, 80)) {
    const m = /(?:prepared\s+for|client(?:\s+name)?|investor(?:\s+name)?|name\s+of\s+(?:the\s+)?(?:client|investor))\s*[:\-|]\s*([A-Za-z][A-Za-z .']{2,60})/i.exec(l);
    if (m) return m[1].replace(/\s+/g, " ").replace(/\s*\|.*$/, "").trim();
  }
  return null;
}

/** Open a PDF (trying the candidates) and tell whether it is a CAS or an advisory report. */
export async function identifyPdf(bytes: Uint8Array, candidates: string[]): Promise<PdfIdentity> {
  let password: string | null;
  try {
    password = await findWorkingPassword(bytes, candidates);
  } catch (e) {
    return e instanceof PdfPasswordError ? { kind: "LOCKED" } : { kind: "UNREADABLE", error: "Not a readable PDF." };
  }
  let lines: string[];
  try {
    lines = await extractPdfLines(bytes, password);
  } catch {
    return { kind: "UNREADABLE", error: "The PDF opened but its text could not be read (scanned image?)." };
  }
  if (imageOnly(lines)) return { kind: "IMAGE_ONLY", locked: password !== null };
  // Try the CAS reader, then the report readers; the words on the page decide only when both fail
  // (reports often quote "Consolidated Account Statement" and CAMS/KFintech too).
  let casError: string | null = null;
  try {
    return { kind: "CAS", cas: parseCasLines(lines), passwordProtected: password !== null };
  } catch (e) {
    casError = e instanceof CasParseError ? e.message : "The CAS could not be read.";
  }
  const r = await readReportDetailed(bytes, password === null ? [] : [password]);
  // A statement the CAS reader failed on still has folio / unit-balance lines; a report does not.
  if (!r.report && looksLikeCas(lines.slice(0, 40).join("\n")) && /folio no|closing unit balance/i.test(lines.join("\n"))) {
    return { kind: "CAS_UNREADABLE", error: casError };
  }
  return { kind: "REPORT", report: r.report, error: r.error, nameGuess: r.report?.clientName ?? guessClientName(lines) };
}

/** Read a report without throwing on layouts the readers do not know: the error is returned instead. */
export async function readReportDetailed(bytes: Uint8Array, candidates: string[]): Promise<{ report: AdvisoryReportParse | null; error: string | null }> {
  let pw: string | null;
  try {
    pw = await findWorkingPassword(bytes, candidates);
  } catch (e) {
    if (e instanceof PdfPasswordError) throw new AppError("The advisory report is password protected and none of the passwords worked.");
    throw new AppError("The advisory report could not be read as a PDF.");
  }
  try {
    const pages = await extractPdfPages(bytes, pw);
    if (imageOnly(pagesToLines(pages))) return { report: null, error: IMAGE_ONLY_REPORT };
    return { report: parseAdvisoryReportPages(pages), error: null };
  } catch (e) {
    if (e instanceof ReportParseError) return { report: null, error: e.message };
    return { report: null, error: "The report's text could not be read." };
  }
}
