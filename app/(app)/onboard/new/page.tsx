import { PAGES } from "@/lib/brand";
import { HubTabs } from "@/components/app/hub-tabs";
import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { PageHeader } from "@/components/app/page-header";
import { Field, Input, Select } from "@/components/ui/form";
import { ALL_ROLES, pageData } from "@/lib/server";
import { listAdvisors } from "@/services/clients";
import { onboardNewInvestorAction } from "../actions";

// The report may go to Claude.
export const maxDuration = 300;

export const metadata = { title: PAGES.newInvestor };

export default async function NewInvestorPage() {
  const { advisors, actor } = await pageData(async (tx) => ({ advisors: await listAdvisors(tx) }), ALL_ROLES);
  const ops = actor.role === "OPERATIONS";
  const advisorField = (
    <Field label={ops ? "Primary advisor *" : "Primary advisor"} hint="The advisor reviews and approves the draft plan.">
      <Select name="advisor_id" defaultValue={ops ? "" : actor.id} required={ops}>
        {ops ? <option value="" disabled>Choose advisor…</option> : null}
        {(ops ? advisors.filter((a) => a.role !== "OPERATIONS") : advisors).map((a) => <option key={a.id} value={a.id}>{a.full_name} ({a.role.toLowerCase()})</option>)}
      </Select>
    </Field>
  );
  return (
    <>
      <PageHeader
        title={PAGES.onboardHub}
        subtitle="Everything is read from the CAS and the advisory report. Each client opens as a draft plan for you to approve."
      />
      <HubTabs hub="onboard" active="new" role={actor.role} />
      <ActionForm action={onboardNewInvestorAction} className="max-w-5xl">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="flex flex-col justify-center rounded-xl border-2 border-dashed border-border bg-white px-6 py-8 text-center">
            <div className="text-[15px] font-semibold">The advisory report</div>
            <p className="mx-auto mt-1 max-w-sm text-sm text-muted">Buys and SIP starts for a client with no mutual funds yet. Their first CAS later shows the buys done.</p>
            <Input type="file" name="report" accept="application/pdf" required aria-label="Advisory report (PDF)" className="mx-auto mt-4 max-w-xs" />
          </div>
          <div className="space-y-3 rounded-xl border border-border bg-white p-4">
            <Field label="Client name *" hint="As on the PAN; must match the name in the report.">
              <Input name="full_name" required autoComplete="off" />
            </Field>
            <Field label="PAN *" hint="The report never has it; their first CAS is matched to them by PAN.">
              <Input name="pan" required autoComplete="off" maxLength={10} placeholder="ABCDE1234F" className="uppercase" />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Mobile"><Input name="mobile" inputMode="tel" autoComplete="off" placeholder="98xxxxxxxx" /></Field>
              <Field label="Email"><Input name="email" type="email" autoComplete="off" /></Field>
            </div>
            {ops ? advisorField : null}
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-start gap-4">
          <SubmitButton size="lg">Read report &amp; create draft</SubmitButton>
          <details className="min-w-72 flex-1 rounded-xl border border-border bg-white">
            <summary className="cursor-pointer select-none px-4 py-2.5 text-sm"><span className="font-medium">More options</span> <span className="text-muted">· {ops ? "" : actor.role === "ADMIN" ? "advisor, " : ""}report password</span></summary>
            <div className="grid gap-3 border-t border-border px-4 py-3 sm:grid-cols-2">
              <Field label="Report password (only if it has one)"><Input name="password" type="password" autoComplete="off" /></Field>
              {actor.role === "ADMIN" ? advisorField : null}
            </div>
          </details>
        </div>
        <p className="mt-3 text-xs text-muted">
          The report may only buy funds and start SIPs. Anything its words do not make clear becomes a question on the draft. On approval, the total it buys is recorded as fresh money.
        </p>
      </ActionForm>
    </>
  );
}
