import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/app/page-header";
import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { ClientFields } from "@/components/app/client-form";
import { ADVISORY_ROLES, pageData } from "@/lib/server";
import { listAdvisors } from "@/services/clients";
import { createClientAction } from "../actions";

export const metadata = { title: "New client" };

export default async function NewClientPage() {
  const { advisors, actor } = await pageData(async (tx) => ({ advisors: await listAdvisors(tx) }), ADVISORY_ROLES);
  return (
    <>
      <PageHeader title="New client" subtitle="A human-readable client ID (MN-xxxxx) is generated automatically." />
      <Card className="max-w-3xl">
        <CardContent>
          <ActionForm action={createClientAction} className="space-y-4">
            <ClientFields advisors={actor.role === "ADMIN" ? advisors : undefined} />
            {actor.role === "ADVISOR" ? <p className="text-xs text-muted">You will be the primary advisor.</p> : null}
            <SubmitButton>Create client</SubmitButton>
          </ActionForm>
        </CardContent>
      </Card>
    </>
  );
}
