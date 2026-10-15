import { PAGES } from "@/lib/brand";
import { HubTabs } from "@/components/app/hub-tabs";
import { PageHeader } from "@/components/app/page-header";
import { casPasswordTemplate } from "@/lib/cas/password";
import { reportAiConfigured } from "@/lib/integrations/report-ai";
import { ALL_ROLES, pageData } from "@/lib/server";
import { listAdvisors } from "@/services/clients";
import { ClientOnboarder } from "./client-onboarder";

// Reading PDFs and saving a whole CAS can take a while on a cold start; a report
// (or a picture-only CAS) may also go to Claude.
export const maxDuration = 300;

export const metadata = { title: PAGES.onboardHub };

export default async function OnboardPage() {
  const { advisors, actor } = await pageData(async (tx) => ({ advisors: await listAdvisors(tx) }), ALL_ROLES);
  const ops = actor.role === "OPERATIONS";
  return (
    <>
      <PageHeader
        title={PAGES.onboardHub}
        subtitle="Everything is read from the CAS and the advisory report. Each client opens as a draft plan for you to approve."
      />
      <HubTabs hub="onboard" active="client" role={actor.role} />
      <div className="max-w-5xl">
        <ClientOnboarder
          advisors={ops ? advisors.filter((a) => a.role !== "OPERATIONS") : advisors}
          defaultAdvisorId={ops ? "" : actor.id}
          advisorRequired={ops}
          canChooseAdvisor={actor.role !== "ADVISOR"}
          aiReady={reportAiConfigured()}
          templateSet={casPasswordTemplate() !== null}
        />
        <div className="mt-6 grid gap-3 text-xs text-muted sm:grid-cols-3">
          <p><b className="block text-ink">From the CAS</b>Name, PAN, mobile, email, every fund, units and SIPs.</p>
          <p><b className="block text-ink">From the report</b>Sell / Buy / Keep / SIP, risk, goal, fresh money, full or additional.</p>
          <p><b className="block text-ink">Checked by itself</b>Every report line is tied to the CAS. A CAS newer than the report, scanned PDFs and wrong pairs are flagged per client; what the built-in reader cannot settle goes to Claude.</p>
        </div>
      </div>
    </>
  );
}
