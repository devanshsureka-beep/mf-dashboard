import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select, Textarea } from "@/components/ui/form";
import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { Money } from "@/components/app/money";
import type { ReportQuestionRow } from "@/services/plans";
import { answerReportQuestionAction } from "../actions";

/** What the report says vs what the newer CAS shows (report vs a CAS taken after it). */
function DiffFacts({ d }: { d: NonNullable<ReportQuestionRow["report_diff"]> }) {
  return (
    <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[12px] text-slate-700">
      <span>Report: {d.report_amount != null ? <Money value={d.report_amount} /> : "—"}</span>
      <span>New CAS holds: <Money value={d.cas_value} /></span>
      {d.sold_since > 0 ? <span className="text-red-700">Sold since the report: <Money value={d.sold_since} /></span> : null}
      {d.bought_since > 0 ? <span className="text-blue-700">Bought since the report: <Money value={d.bought_since} /></span> : null}
      {d.done_answer ? <span className="text-emerald-700">Done (answered): <Money value={d.done_answer.amount} /> on {d.done_answer.date}{d.done_call_id ? " · recorded" : " · recorded when the plan is approved"}</span> : null}
    </div>
  );
}

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
          The report&rsquo;s words for these funds could not be read as Buy, Sell or Keep, or a newer CAS differs from the report. Each is kept until you answer.
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
            {r.report_diff ? <DiffFacts d={r.report_diff} /> : null}
            {r.open && canAnswer ? (
              <ActionForm action={answerReportQuestionAction.bind(null, clientId, planId, r.id)} className="mt-2" resetOnSuccess>
                <div className="grid gap-2 sm:grid-cols-[110px_150px_minmax(0,1fr)]">
                  <Select name="action" defaultValue={r.report_diff?.suggest ?? "SELL"} aria-label="Buy, Sell or Keep">
                    <option value="SELL">Sell</option>
                    <option value="RETAIN">Keep</option>
                    <option value="BUY">Buy</option>
                  </Select>
                  <Input name="size" placeholder="₹ amount or 33%" aria-label="Line amount in rupees, or a percentage of the holding"
                    defaultValue={r.report_diff ? String(Math.round(Math.max(r.report_diff.report_amount ?? 0, r.report_diff.done_amount) || 0) || "") : Number(r.target_amount) > 0 ? String(Math.round(Number(r.target_amount))) : ""} />
                  <Textarea name="explanation" rows={1} required placeholder="What the report means (kept on the line)" aria-label="Explanation" className="min-h-9 py-1.5" />
                </div>
                {r.report_diff ? (
                  <div className="mt-2 grid gap-2 sm:grid-cols-[110px_150px_150px_minmax(0,1fr)] sm:items-center">
                    <span className="text-xs text-muted">Already done</span>
                    <Input name="done_amount" inputMode="decimal" aria-label="Amount already done (₹)" placeholder="₹ done, if any"
                      defaultValue={r.report_diff.done_amount > 0 ? String(r.report_diff.done_amount) : ""} />
                    <Input name="done_date" type="date" aria-label="Date it was done" defaultValue={r.report_diff.done_date ?? ""} />
                    <span className="text-[11.5px] text-muted">Recorded as a call and its execution (CAS as proof). Clear it for the client&rsquo;s own trade.</span>
                  </div>
                ) : null}
                <div className="mt-2"><SubmitButton size="sm">Save answer</SubmitButton></div>
              </ActionForm>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}
