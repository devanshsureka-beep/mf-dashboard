/**
 * Report lines the built-in readers cannot tie to the CAS go to Claude; points
 * still open after an answer go back to Claude with that answer as the draft
 * (up to `maxRounds`, within `deadline`). Every answer passes the same CAS
 * tie-out as any report. No Next.js imports.
 */
import { AppError } from "@/lib/errors";
import { askClaudeForReport, type ReportAiInput } from "@/lib/integrations/report-ai";
import type { CasParseOutput } from "@/lib/parsers/cas";
import { sameInvestor, type AdvisoryReportParse } from "@/lib/parsers/advisory-report";
import type { PlanKind } from "@/types/domain";
import { nameScore } from "@/lib/domain/doc-pairing";
import { isStaleCasProblem } from "@/lib/domain/report-plan";
import { checkDocumentsBelongTogether, holdingsFromCas, previewOnboarding } from "@/services/onboarding";

export type ResolveResult =
  | { status: "RESOLVED"; report: AdvisoryReportParse; kind: PlanKind; corrections: string[]; rounds: number }
  | { status: "OPEN"; problems: string[]; corrections: string[]; rounds: number; error: string | null }
  | { status: "WRONG_PAIR"; message: string; corrections: string[]; rounds: number };

type Ask = (input: ReportAiInput, timeoutMs: number) => Promise<{ report: AdvisoryReportParse; corrections: string[] }>;

export async function resolveWithClaude(args: {
  /** null: a new investor with no mutual funds yet (no CAS); `check` and `expectedName` then decide. */
  cas: CasParseOutput | null;
  /** New investor: the name the desk entered (the report must be for them). */
  expectedName?: string | null;
  reportPdf: Uint8Array;
  draft: AdvisoryReportParse | null;
  readerError: string | null;
  problems: string[];
  deadline: number;
  /** Original report file name: proves the client when the report prints no name. */
  reportFileName?: string | null;
  maxRounds?: number;
  minRoundMs?: number;
  ask?: Ask;
  /** Tie-out of a candidate report (default: full rebalancing). */
  check?: (report: AdvisoryReportParse) => { kind: PlanKind; problems: string[] };
}): Promise<ResolveResult> {
  const cas = args.cas;
  if (!cas && !args.check) throw new Error("resolveWithClaude: a check is required without a CAS");
  const check = args.check ?? ((r: AdvisoryReportParse) => ({ kind: "FULL" as PlanKind, problems: previewOnboarding(cas!, r).problems }));
  const ask = args.ask ?? askClaudeForReport;
  const maxRounds = args.maxRounds ?? 3;
  const minRoundMs = args.minRoundMs ?? 75_000;
  let holdings;
  try {
    holdings = cas ? holdingsFromCas(cas) : [];
  } catch (e) {
    return { status: "OPEN", problems: [`The CAS does not reconcile: ${(e as Error).message}`], corrections: [], rounds: 0, error: null };
  }
  // A CAS older than the report cannot be fixed by reading the report again.
  if (args.problems.some(isStaleCasProblem)) return { status: "OPEN", problems: args.problems, corrections: [], rounds: 0, error: null };
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
        pdf: args.reportPdf, holdings, casValuationDate: cas?.valuationDate ?? null,
        draft, readerError: round === 1 ? args.readerError : null, problems,
      }, left - 5_000);
    } catch (e) {
      const error = e instanceof AppError ? e.message : "Claude could not be reached.";
      if (!(e instanceof AppError)) throw e;
      return { status: "OPEN", problems, corrections, rounds, error };
    }
    rounds = round;
    corrections = [...corrections, ...ai.corrections.map((c) => (round > 1 ? `(round ${round}) ${c}` : c))];
    // Never borrow the CAS name: a report with no printed name must at least be named after the client.
    const named = ai.report.clientName
      ?? (cas && args.reportFileName && nameScore(cas.investor.name, args.reportFileName) >= 1 ? cas.investor.name : null);
    const candidate = { ...ai.report, clientName: named };
    if (cas) {
      const together = checkDocumentsBelongTogether(cas, candidate);
      if (together.problem && ai.report.clientName) return { status: "WRONG_PAIR", message: together.problem, corrections, rounds };
    } else if (args.expectedName && ai.report.clientName && !sameInvestor(args.expectedName, ai.report.clientName)) {
      return { status: "WRONG_PAIR", message: `The report is for "${ai.report.clientName}", not "${args.expectedName}".`, corrections, rounds };
    }
    const checked = check(candidate);
    problems = checked.problems;
    if (!problems.length) {
      return {
        status: "RESOLVED",
        kind: checked.kind,
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
    if (problems.some(isStaleCasProblem)) break;
    draft = candidate;
  }
  return { status: "OPEN", problems, corrections, rounds, error: rounds ? null : "Not enough time left for Claude in this request." };
}
