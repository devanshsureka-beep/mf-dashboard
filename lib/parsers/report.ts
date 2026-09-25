/**
 * Advisory report entry point: the dedicated reader for the known Univest
 * layout, otherwise the layout-independent table reader. Both return the same
 * shape and go through the same cross-checks and CAS tie-out.
 */
import { pagesToLines, type PdfPage } from "@/lib/pdf/text";
import { isUnivestV1, parseAdvisoryReportLines, ReportParseError, type AdvisoryReportParse } from "./advisory-report";
import { looksLikeAdvisoryReport, parseAdvisoryReportGeneric } from "./report-generic";

export function parseAdvisoryReportPages(pages: PdfPage[]): AdvisoryReportParse {
  const lines = pagesToLines(pages);
  if (isUnivestV1(lines)) return parseAdvisoryReportLines(lines);
  if (!looksLikeAdvisoryReport(pages)) throw new ReportParseError("This does not look like an advisory / portfolio report.");
  return parseAdvisoryReportGeneric(pages);
}
