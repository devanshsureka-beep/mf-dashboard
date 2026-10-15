import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { SecuritySelect } from "@/components/app/security-select";
import type { listAllSecurities } from "@/services/securities";
import type { PlanItemProgress } from "@/types/domain";
import {
  cancelPlanItemAction, convertBuyToSipAction, deletePlanItemAction, updatePlanItemAction,
} from "../actions";

/** Edit / amend one plan line (a popover under its name). */
export function ItemEditor({ i, clientId, planId, isActive, securities, heldIds, label, alignRight }: {
  i: PlanItemProgress; clientId: string; planId: string; isActive: boolean; label?: string; alignRight?: boolean;
  securities: Awaited<ReturnType<typeof listAllSecurities>>; heldIds: string[];
}) {
  return (
    <details className={alignRight ? "relative text-xs" : "text-xs"}>
      <summary className="cursor-pointer text-brand">{label ?? (isActive ? "Amend / cancel" : i.needs_review ? "Resolve / edit" : "Edit")}</summary>
      <div className={`absolute z-30 mt-1 w-[520px] max-w-[90vw] rounded-lg border border-border bg-white p-3 text-left shadow-lg ${alignRight ? "right-0" : ""}`}>
        <ActionForm action={updatePlanItemAction.bind(null, clientId, planId, i.plan_item_id)} className="grid grid-cols-2 gap-2">
          <Field label="Security" className="col-span-2"><SecuritySelect securities={securities} heldIds={heldIds} defaultValue={i.security_id} /></Field>
          <input type="hidden" name="scheme_name" value={i.scheme_name} />
          <input type="hidden" name="folio_number" value={i.folio_number ?? ""} />
          <Field label="Action">
            <Select name="action" defaultValue={i.action}><option>SELL</option><option>BUY</option><option value="RETAIN">KEEP</option></Select>
          </Field>
          <Field label="Target amount (₹)"><Input name="target_amount" defaultValue={i.original_target_amount || ""} /></Field>
          <Field label="Current value (₹)"><Input name="current_amount" defaultValue={i.current_amount ?? ""} /></Field>
          <Field label="Target units"><Input name="target_units" defaultValue={i.target_units ?? ""} /></Field>
          <Field label="Target weight %"><Input name="target_weight" defaultValue={i.target_weight ?? ""} /></Field>
          <Field label="Priority"><Input name="priority" defaultValue={i.priority} /></Field>
          <Field label="Reason" className="col-span-2"><Textarea name="reason" rows={2} defaultValue={i.reason ?? ""} /></Field>
          {isActive ? <Field label="Reason for amending an ACTIVE plan *" className="col-span-2"><Input name="change_reason" required /></Field> : null}
          <div className="col-span-2"><SubmitButton size="sm">Save</SubmitButton></div>
        </ActionForm>
        {i.action === "BUY" && i.item_status === "OPEN" && i.yet_to_advise_amount > 0 ? (
          <div className="mt-3 border-t border-border pt-3">
            <div className="mb-1 font-medium text-ink">Move to SIP</div>
            <ActionForm action={convertBuyToSipAction.bind(null, clientId, planId, i.plan_item_id)} className="grid grid-cols-2 gap-2">
              <Field label="Monthly SIP ₹ *"><Input name="monthly_amount" inputMode="decimal" required /></Field>
              <Field label="Lump sum to move ₹" hint={`Up to ${Math.round(i.yet_to_advise_amount).toLocaleString("en-IN")} not yet advised`}>
                <Input name="lumpsum_amount" inputMode="decimal" defaultValue={Math.round(i.yet_to_advise_amount)} />
              </Field>
              <Field label="Debit day"><Input name="debit_day" inputMode="numeric" /></Field>
              <Field label="Reason *"><Input name="reason" required placeholder="e.g. client prefers SIP" /></Field>
              <div className="col-span-2"><SubmitButton size="sm" variant="outline">Move to SIP</SubmitButton></div>
            </ActionForm>
          </div>
        ) : null}
        <div className="mt-3 border-t border-border pt-3">
          {isActive ? (
            <ActionForm action={cancelPlanItemAction.bind(null, clientId, planId, i.plan_item_id)} className="flex gap-2">
              <Input name="reason" placeholder="Reason to cancel this item" required />
              <SubmitButton size="sm" variant="danger">Cancel item</SubmitButton>
            </ActionForm>
          ) : (
            <ActionForm action={deletePlanItemAction.bind(null, clientId, planId, i.plan_item_id)}>
              <SubmitButton size="sm" variant="danger" confirm="Delete this line from the draft?">Delete from draft</SubmitButton>
            </ActionForm>
          )}
        </div>
      </div>
    </details>
  );
}

