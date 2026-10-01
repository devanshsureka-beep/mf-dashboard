/**
 * Report lines the built-in readers cannot tie to the CAS go to Claude; points
 * still open after an answer go back to Claude with that answer as the draft
 * (up to `maxRounds`, within `deadline`). Every answer passes the same CAS
 * tie-out as any report. No Next.js imports.
 */
import { AppError } from "@/lib/errors";
import { askClaudeForReport, type ReportAiInput } from "@/lib/integrations/report-ai";
import type { CasParseOutput } from "@/lib/parsers/cas";
import type { AdvisoryReportParse } from "@/lib/parsers/advisory-report";
import { checkDocumentsBelongTogether, holdingsFromCas, previewOnboarding } from "@/services/onboarding";

export type ResolveResult =
  | { status: "RESOLVED"; report: AdvisoryReportParse; corrections: string[]; rounds: number }
  | { status: "OPEN"; problems: string[]; corrections: string[]; rounds: number; error: string | null }
  | { status: "WRONG_PAIR"; message: string; corrections: string[]; rounds: number };

type Ask = (input: ReportAiInput, timeoutMs: number) => Promise<{ report: AdvisoryReportParse; corrections: string[] }>;

export async function resolveWithClaude(args: {
  cas: CasParseOutput;
  reportPdf: Uint8Array;
  draft: AdvisoryReportParse | null;
  readerError: string | null;
  problems: string[];
  deadline: number;
  maxRounds?: number;
  minRoundMs?: number;
  ask?: Ask;
}): Promise<ResolveResult> {
  const ask = args.ask ?? askClaudeForReport;
  const maxRounds = args.maxRounds ?? 3;
  const minRoundMs = args.minRoundMs ?? 75_000;
  let holdings;
  try {
    holdings = holdingsFromCas(args.cas);
  } catch (e) {
    return { status: "OPEN", problems: [`The CAS does not reconcile: ${(e as Error).message}`], corrections: [], rounds: 0, error: null };
  }
  let draft = args.draft;
  let problems = args.problems;
  let corrections: string[] = [];
  let rounds = 0;
  for (let round = 1; round <= maxRounds; round++) {
    const left = args.deadline - Date.now();
    if (left < minRoundMs) break;
    let ai;
    try {
      ai = await ask({
        pdf: args.reportPdf, holdings, casValuationDate: args.cas.valuationDate,
        draft, readerError: round === 1 ? args.readerError : null, problems,
      }, left - 5_000);
    } catch (e) {
      const error = e instanceof AppError ? e.message : "Claude could not be reached.";
      if (!(e instanceof AppError)) throw e;
      return { status: "OPEN", problems, corrections, rounds, error };
    }
    rounds = round;
    corrections = [...corrections, ...ai.corrections.map((c) => (round > 1 ? `(round ${round}) ${c}` : c))];
    const candidate = { ...ai.report, clientName: ai.report.clientName ?? args.cas.investor.name };
    const together = checkDocumentsBelongTogether(args.cas, candidate);
    if (together.problem && ai.report.clientName) return { status: "WRONG_PAIR", message: together.problem, corrections, rounds };
    problems = previewOnboarding(args.cas, candidate).problems;
    if (!problems.length) {
      return {
        status: "RESOLVED",
        rounds,
        corrections,
        report: {
          ...candidate,
          deploymentNotes: [
            ...candidate.deploymentNotes.filter((n) => !/^Report read with Claude|^ {2}- /.test(n)),
            ...(corrections.length ? ["Report read with Claude's help; corrected lines:", ...corrections.map((c) => `  - ${c}`)] : ["Report read with Claude's help."]),
          ],
        },
      };
    }
    draft = candidate;
  }
  return { status: "OPEN", problems, corrections, rounds, error: rounds ? null : "Not enough time left for Claude in this request." };
}
