import { PAGES } from "@/lib/brand";
import { HubTabs } from "@/components/app/hub-tabs";
import { PageHeader } from "@/components/app/page-header";
import { requireActor } from "@/lib/auth/session";
import { Checker } from "./checker";

// Reading two PDFs can take a few seconds on a cold start.
export const maxDuration = 120;

export const metadata = { title: "Document check" };

export default async function CheckDocumentsPage() {
  const actor = await requireActor();
  return (
    <>
      <PageHeader
        title={PAGES.onboardHub}
        subtitle="See exactly what onboarding would read and create from a CAS and an advisory report, with every check shown. Nothing is saved."
      />
      <HubTabs hub="onboard" active="check" role={actor.role} />
      <Checker />
    </>
  );
}
