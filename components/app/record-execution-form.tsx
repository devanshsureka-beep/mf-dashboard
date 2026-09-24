import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { ActionForm, SubmitButton } from "./action-form";
import { formatINR, formatUnits, todayIST } from "@/lib/format";
import { humanize } from "@/lib/format";
import { VERIFICATION_TYPES, type AdviceItemView } from "@/types/domain";
import type { ActionResult } from "@/lib/actions";

/** Record one (possibly partial) execution against a call. */
export function RecordExecutionForm({ advice, action, compact = false }: {
  advice: Pick<AdviceItemView, "quantity_basis" | "pending_amount" | "pending_units" | "action">;
  action: (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
  compact?: boolean;
}) {
  return (
    <ActionForm action={action} className={compact ? "grid gap-2 md:grid-cols-6" : "grid gap-3 md:grid-cols-4"} resetOnSuccess>
      <Field label="Execution date *"><Input type="date" name="execution_date" defaultValue={todayIST()} max={todayIST()} required /></Field>
      {!compact ? <Field label="Time"><Input type="time" name="execution_time" /></Field> : null}
      <Field label={`Amount ₹ ${advice.quantity_basis === "UNITS" ? "(proceeds)" : "*"}`} hint={compact ? undefined : `Pending ${formatINR(advice.pending_amount)}`}>
        <Input name="executed_amount" inputMode="decimal" placeholder={String(Math.round(advice.pending_amount))} required={advice.quantity_basis === "AMOUNT"} />
      </Field>
      <Field label={`Units ${advice.quantity_basis === "UNITS" ? "*" : ""}`} hint={!compact && advice.pending_units ? `Pending ${formatUnits(advice.pending_units)} units` : undefined}>
        <Input name="executed_units" inputMode="decimal" required={advice.quantity_basis === "UNITS"} />
      </Field>
      {!compact ? <Field label="NAV / price"><Input name="execution_price" inputMode="decimal" /></Field> : null}
      <Field label="Verification *">
        <Select name="verification_type" defaultValue="CLIENT_CONFIRMED">
          {VERIFICATION_TYPES.map((v) => <option key={v} value={v}>{humanize(v)}</option>)}
        </Select>
      </Field>
      <Field label="Status">
        <Select name="status" defaultValue="EXECUTED">
          <option value="EXECUTED">Executed</option>
          <option value="PENDING">Order placed (awaiting confirmation)</option>
        </Select>
      </Field>
      {!compact ? (
        <>
          <Field label="Proof (PDF/image)" hint="Required for PROOF_VERIFIED"><Input type="file" name="proof" accept="application/pdf,image/png,image/jpeg" className="pt-1.5" /></Field>
          <Field label="Notes" className="md:col-span-2"><Textarea name="notes" rows={2} /></Field>
          <label className="flex items-center gap-2 text-xs text-muted md:col-span-2">
            <input type="checkbox" name="allow_over" value="yes" /> Allow over-execution (&gt;10% above the call)
          </label>
        </>
      ) : <input type="hidden" name="notes" value="" />}
      <div className={compact ? "flex items-end" : "md:col-span-4"}>
        <SubmitButton size={compact ? "sm" : "md"} variant="success">Record execution</SubmitButton>
      </div>
    </ActionForm>
  );
}
