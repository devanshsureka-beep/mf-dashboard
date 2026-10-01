import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { PageHeader } from "@/components/app/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/form";
import { casPasswordTemplate } from "@/lib/cas/password";
import { ALL_ROLES, pageData } from "@/lib/server";
import { listAdvisors } from "@/services/clients";
import { onboardAction } from "./actions";

// Reading PDFs and saving a whole CAS can take a while on a cold start.
export const maxDuration = 120;

export const metadata = { title: "Onboard client" };

export default async function OnboardPage() {
  const { advisors, actor } = await pageData(async (tx) => ({ advisors: await listAdvisors(tx) }), ALL_ROLES);
  const templateSet = casPasswordTemplate() !== null;
  return (
    <>
      <PageHeader
        title="Onboard a Premium client"
        subtitle="Upload the client's CAS and the paid advisory report. The client, current holdings and the plan are filled in automatically."
      />
      <Card className="max-w-3xl">
        <CardContent>
          <ActionForm action={onboardAction} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="CAS (PDF)" hint="KFintech / CAMS consolidated, detailed statement">
                <Input type="file" name="cas" accept="application/pdf" required />
              </Field>
              <Field label="Advisory report (PDF)" hint="The rebalancing & execution report shared with the client">
                <Input type="file" name="report" accept="application/pdf" required />
              </Field>
              <Field label="Client mobile number" hint={templateSet ? "Opens the CAS with the password template (last 4 digits)." : "Password template not configured: enter the password below."}>
                <Input name="mobile" inputMode="tel" autoComplete="off" placeholder="98xxxxxxxx" />
              </Field>
              <Field label="CAS password (only if the mobile number doesn't open it)">
                <Input name="password" type="password" autoComplete="off" />
              </Field>
              <Field label="Report type" hint="Auto: an existing client's report that only invests fresh money is added to the active plan.">
                <Select name="report_kind" defaultValue="AUTO">
                  <option value="AUTO">Auto-detect</option>
                  <option value="FULL">Full rebalancing (replaces the current plan)</option>
                  <option value="ADDITIONAL">Additional investment (adds to the current plan)</option>
                </Select>
              </Field>
              <Field label="Fresh money (₹, additional investment)" hint="Only if the report does not say it; otherwise read from the report.">
                <Input name="fresh_money" inputMode="numeric" placeholder="e.g. 1500000" />
              </Field>
              {actor.role === "ADMIN" ? (
                <Field label="Primary advisor (for a new client)">
                  <Select name="advisor_id" defaultValue={actor.id}>
                    {advisors.map((a) => <option key={a.id} value={a.id}>{a.full_name} ({a.role.toLowerCase()})</option>)}
                  </Select>
                </Field>
              ) : actor.role === "OPERATIONS" ? (
                <Field label="Primary advisor *" hint="Used for a new client. The advisor reviews and approves the draft plan.">
                  <Select name="advisor_id" defaultValue="" required>
                    <option value="" disabled>Choose advisor…</option>
                    {advisors.filter((a) => a.role !== "OPERATIONS").map((a) => <option key={a.id} value={a.id}>{a.full_name} ({a.role.toLowerCase()})</option>)}
                  </Select>
                </Field>
              ) : null}
            </div>
            <div className="rounded-md bg-gray-50 p-3 text-xs text-muted">
              <p>The client is identified by the PAN in the CAS. The name in the report must match the CAS.</p>
              <p className="mt-1">New client → created with contact details, risk profile and goal from the documents. Existing client → a full report becomes a new draft plan that replaces the current one when approved (the old one stays in history); an additional-investment report becomes a draft tranche that is added to the current plan when approved, with its fresh money counted in money left.</p>
              <p className="mt-1">The plan opens as a DRAFT: check it, then approve{actor.role === "OPERATIONS" ? " (an advisor or admin approves)" : ""}.</p>
            </div>
            <SubmitButton>Read documents &amp; create plan</SubmitButton>
          </ActionForm>
        </CardContent>
      </Card>
    </>
  );
}
