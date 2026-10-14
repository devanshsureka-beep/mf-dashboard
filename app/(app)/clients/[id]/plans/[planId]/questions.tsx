import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select, Textarea } from "@/components/ui/form";
import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { Money } from "@/components/app/money";
import type { ReportQuestionRow } from "@/services/plans";
import { answerReportQuestionAction } from "../actions";

/**
 * Recommendations the report reader could not read as Buy, Sell or Keep. Each
 * stays a Keep line until the desk answers; a draft plan cannot be approved
 * while one is open.
 */
export function ReportQuestions({ rows, clientId, planId, canAnswer }: { rows: ReportQuestionRow[]; clientId: string; planId: string; canAnswer: boolean }) {
  const open = rows.filter((r) => r.open);
  return (
    <Card id="questions" className={open.length ? "mt-4 scroll-mt-14 border-amber-300" : "mt-4 scroll-mt-14"}>
      <CardHeader>
        <CardTitle>Questions from the report{open.length ? ` · ${open.length} open` : ""}</CardTitle>
        <span className="text-xs text-muted">
          The report&rsquo;s words for these funds could not be read as Buy, Sell or Keep. Each is kept until you explain it.
        </span>
      </CardHeader>
      <ul className="divide-y divide-border border-t border-border">
        {rows.map((r) => (
          <li key={r.id} className="px-4 py-3 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate font-medium" title={r.scheme_name}>{r.scheme_name}</div>
                <div className="text-[11.5px] text-muted">
                  {r.folio_number ? `Folio ${r.folio_number} · ` : ""}
                  {r.current_amount ? <>holding <Money value={r.current_amount} /></> : "not in the CAS"}
                </div>
              </div>
              {r.open ? <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900">To answer</span>
                : <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800">Answered</span>}
            </div>
            <div className="mt-1.5 rounded-md bg-slate-50 px-3 py-2 text-[13px]">
              <div><span className="text-muted">Report says:</span> {r.reason?.replace(/^Report: /, "").split(" → ")[0] ?? "—"}</div>
              <div className="font-medium">{r.report_question}</div>
              {r.report_answer ? (
                <div className="mt-1 text-emerald-800">
                  Answer: {r.action === "RETAIN" ? "Keep" : <>{r.action === "SELL" ? "Sell" : "Buy"} <Money value={r.target_amount} /></>} · {r.report_answer}
                </div>
              ) : null}
            </div>
            {r.open && canAnswer ? (
              <ActionForm action={answerReportQuestionAction.bind(null, clientId, planId, r.id)} className="mt-2" resetOnSuccess>
                <div className="grid gap-2 sm:grid-cols-[120px_160px_minmax(0,1fr)_auto]">
                  <Select name="action" defaultValue="SELL" aria-label="Buy, Sell or Keep">
                    <option value="SELL">Sell</option>
                    <option value="RETAIN">Keep</option>
                    <option value="BUY">Buy</option>
                  </Select>
                  <Input name="size" placeholder="₹ amount or 33%" aria-label="Amount in rupees, or a percentage of the holding" />
                  <Textarea name="explanation" rows={1} required placeholder="What the report means (kept on the line)" aria-label="Explanation" className="min-h-9 py-1.5" />
                  <SubmitButton size="sm">Save answer</SubmitButton>
                </div>
              </ActionForm>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}
