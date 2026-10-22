import type { ReportQuestionRow } from "@/services/plans";
import { approveReportLinesAction, reopenReportLineAction } from "../actions";
import { ReportCheck } from "./report-check";

/**
 * Differences between the report and the CAS (and report words that could not be read as Buy,
 * Sell or Keep), one line each, approved together. A draft plan cannot be approved while one is open.
 */
export function ReportQuestions({ rows, clientId, planId, canAnswer, title, draft = false }: {
  rows: ReportQuestionRow[]; clientId: string; planId: string; canAnswer: boolean; title?: string; draft?: boolean;
}) {
  return (
    <ReportCheck rows={rows} canAnswer={canAnswer} draft={draft} title={title}
      approve={approveReportLinesAction.bind(null, clientId, planId)} reopen={reopenReportLineAction.bind(null, clientId, planId)} />
  );
}
