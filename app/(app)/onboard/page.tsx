import { PAGES } from "@/lib/brand";
import { HubTabs } from "@/components/app/hub-tabs";
import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { PageHeader } from "@/components/app/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/form";
import { casPasswordTemplate } from "@/lib/cas/password";
import { ALL_ROLES, pageData } from "@/lib/server";
import { listAdvisors } from "@/services/clients";
import { onboardAction, onboardNewInvestorAction } from "./actions";

// Reading PDFs and saving a whole CAS can take a while on a cold start; a new
// investor's report may also go to Claude.
export const maxDuration = 300;

export const metadata = { title: "Onboard client" };

export default async function OnboardPage() {
  const { advisors, actor } = await pageData(async (tx) => ({ advisors: await listAdvisors(tx) }), ALL_ROLES);
  const templateSet = casPasswordTemplate() !== null;
  return (
    <>
      <PageHeader
        title={PAGES.onboardHub}
        subtitle="CAS + paid advisory report → client, holdings and a draft plan. For an existing client, choose whether the report is a full rebalancing or an additional portfolio (fresh money). A new investor with no mutual funds yet: report only, below."
      />
      <HubTabs hub="onboard" active="one" role={actor.role} />
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
              <Field label="Which CAS is this?" hint="Newer: the client already acted on part of the report. Each difference becomes a question on the plan, prefilled from the CAS's trades since the report.">
                <Select name="cas_kind" defaultValue="SAME">
                  <option value="SAME">The CAS the report was made from</option>
                  <option value="NEWER">A newer CAS (taken after the report)</option>
                </Select>
              </Field>
              <Field label="What is this report?" hint="Auto: an existing client's report that only invests fresh money is added to the active plan.">
                <Select name="report_kind" defaultValue="AUTO">
                  <option value="AUTO">Auto-detect</option>
                  <option value="FULL">Full rebalancing (new client or new plan)</option>
                  <option value="ADDITIONAL">Additional portfolio (existing client, fresh money)</option>
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

      <Card id="new-investor" className="mt-4 max-w-3xl scroll-mt-14">
        <CardContent>
          <h2 className="text-[15px] font-semibold">New investor: no mutual funds yet (no CAS)</h2>
          <p className="mb-3 mt-0.5 text-xs text-muted">
            For a client starting their mutual-fund journey with us. Upload only the advisory report; the client is created from the details below.
          </p>
          <ActionForm action={onboardNewInvestorAction} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Advisory report (PDF) *" hint="The plan for the new money: funds to buy and SIPs to start">
                <Input type="file" name="report" accept="application/pdf" required />
              </Field>
              <Field label="Report password (only if it has one)">
                <Input name="password" type="password" autoComplete="off" />
              </Field>
              <Field label="Client name *" hint="As on the PAN; must match the name in the report">
                <Input name="full_name" required autoComplete="off" />
              </Field>
              <Field label="PAN *" hint="Their first CAS is matched to them by PAN">
                <Input name="pan" required autoComplete="off" maxLength={10} placeholder="ABCDE1234F" className="uppercase" />
              </Field>
              <Field label="Mobile">
                <Input name="mobile" inputMode="tel" autoComplete="off" placeholder="98xxxxxxxx" />
              </Field>
              <Field label="Email">
                <Input name="email" type="email" autoComplete="off" />
              </Field>
              {actor.role === "ADMIN" ? (
                <Field label="Primary advisor">
                  <Select name="advisor_id" defaultValue={actor.id}>
                    {advisors.map((a) => <option key={a.id} value={a.id}>{a.full_name} ({a.role.toLowerCase()})</option>)}
                  </Select>
                </Field>
              ) : actor.role === "OPERATIONS" ? (
                <Field label="Primary advisor *" hint="The advisor reviews and approves the draft plan.">
                  <Select name="advisor_id" defaultValue="" required>
                    <option value="" disabled>Choose advisor…</option>
                    {advisors.filter((a) => a.role !== "OPERATIONS").map((a) => <option key={a.id} value={a.id}>{a.full_name} ({a.role.toLowerCase()})</option>)}
                  </Select>
                </Field>
              ) : null}
            </div>
            <div className="rounded-md bg-gray-50 p-3 text-xs text-muted">
              <p>The report may only buy funds and start SIPs (nothing to sell, no SIP to stop). Every buy becomes a Buy line; anything the report&rsquo;s words do not make clear becomes a question on the plan.</p>
              <p className="mt-1">On approval, the total the plan buys is recorded as fresh money, so &ldquo;in bank&rdquo; and &ldquo;since onboarding&rdquo; start from it. Upload the client&rsquo;s first CAS once they have invested: it shows the buys as done.</p>
            </div>
            <SubmitButton>Read report &amp; create client and plan</SubmitButton>
          </ActionForm>
        </CardContent>
      </Card>
    </>
  );
}
