import { PageHeader } from "@/components/app/page-header";
import { requireActor } from "@/lib/auth/session";
import { Checker } from "./checker";

// Reading two PDFs can take a few seconds on a cold start.
export const maxDuration = 120;

export const metadata = { title: "Check documents" };

export default async function CheckDocumentsPage() {
  await requireActor();
  return (
    <>
      <PageHeader
        title="Check documents"
        subtitle="See exactly what onboarding would read and create from a CAS and an advisory report, with every check shown. Nothing is saved."
      />
      <Checker />
    </>
  );
}
