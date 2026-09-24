import { Card, CardContent } from "@/components/ui/card";
import { Field, Input, Textarea } from "@/components/ui/form";
import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { PageHeader } from "@/components/app/page-header";
import { Money } from "@/components/app/money";
import { formatDate, todayIST } from "@/lib/format";
import { ADVISORY_ROLES, pageData } from "@/lib/server";
import { getClientSummary } from "@/services/clients";
import { createPlanAction } from "../actions";

export const metadata = { title: "New advisory plan" };

export default async function NewPlanPage(props: PageProps<"/clients/[id]/plans/new">) {
  const { id } = await props.params;
  const { c } = await pageData(async (tx) => ({ c: await getClientSummary(tx, id) }), ADVISORY_ROLES);
  return (
    <>
      <PageHeader title={`New advisory plan · ${c.full_name}`} subtitle="The plan is the END STATE recommendation. Creating it does not instruct the client; calls are issued separately." />
      <Card className="max-w-2xl">
        <CardContent>
          <ActionForm action={createPlanAction.bind(null, id)} className="space-y-4">
            <Field label="Plan name *"><Input name="plan_name" required defaultValue="Onboarding rebalancing plan" /></Field>
            <Field label="Plan date"><Input name="plan_date" type="date" defaultValue={todayIST()} /></Field>
            {c.latest_snapshot_id ? (
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" name="snapshot_id" value={c.latest_snapshot_id} defaultChecked className="mt-1" />
                <span>Start from the latest confirmed CAS ({formatDate(c.latest_cas_date)}, <Money value={c.current_portfolio_value} />): every holding is added as RETAIN, which you then change to SELL / SWITCH.</span>
              </label>
            ) : (
              <p className="text-sm text-amber-700">No confirmed CAS yet — the plan will start empty.</p>
            )}
            <Field label="Notes"><Textarea name="notes" rows={3} /></Field>
            <SubmitButton>Create DRAFT plan</SubmitButton>
          </ActionForm>
        </CardContent>
      </Card>
    </>
  );
}
