import { PageHeader } from "@/components/app/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { reportAiConfigured } from "@/lib/integrations/report-ai";
import { ALL_ROLES, pageData } from "@/lib/server";
import { PAGES } from "@/lib/brand";
import { listAdvisors } from "@/services/clients";
import { BulkOnboarder } from "./bulk-onboarder";

// A report Claude has to read can take a few minutes.
export const maxDuration = 300;

export const metadata = { title: PAGES.bulkOnboard };

export default async function BulkOnboardPage() {
  const { advisors, actor } = await pageData(async (tx) => ({ advisors: await listAdvisors(tx) }), ALL_ROLES);
  const ai = reportAiConfigured();
  return (
    <>
      <PageHeader
        title={PAGES.bulkOnboard}
        subtitle="Choose the folder with every client's CAS and advisory report. Files are recognised by what is inside them, paired by client name, and onboarded one client at a time."
      />
      {!ai ? (
        <Card className="mb-4 border-amber-200">
          <CardContent className="text-sm text-amber-800">
            The Claude reader is not set up (<code>REPORT_AI_URL</code> / <code>REPORT_AI_KEY</code>). Reports the built-in
            reader cannot fully reconcile will be listed as &ldquo;Needs review&rdquo; instead of being read by Claude.
          </CardContent>
        </Card>
      ) : null}
      <BulkOnboarder advisors={advisors} defaultAdvisorId={actor.role === "OPERATIONS" ? "" : actor.id} />
      <Card className="mt-4">
        <CardContent className="space-y-1 text-xs text-muted">
          <p><b className="text-ink">1. Read files.</b> Each PDF is opened (a CAS password is looked for in its file name, then the house template) and recognised as a CAS or an advisory report. Each CAS is paired with the report carrying the same client name; change a pair with the drop-down if needed.</p>
          <p><b className="text-ink">2. Onboard.</b> For each pair the built-in reader runs first. Report lines it cannot tie to the CAS go to Claude (with the CAS fund list and the exact points), and Claude&apos;s answer is checked against the CAS the same way. Only a report whose every line ties out is saved, as a DRAFT plan for the advisor to approve.</p>
          <p>Passwords are used only to open the file: never stored, never logged, and removed from the stored file names. Running the same files again is safe: already-onboarded reports are skipped.</p>
        </CardContent>
      </Card>
    </>
  );
}
