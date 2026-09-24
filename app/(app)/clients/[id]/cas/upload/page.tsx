import { Card, CardContent } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { PageHeader } from "@/components/app/page-header";
import { pageData } from "@/lib/server";
import { humanize } from "@/lib/format";
import { CAS_SOURCES } from "@/lib/integrations/contracts";
import { n8nConfigured } from "@/lib/integrations/n8n";
import { getClientSummary } from "@/services/clients";
import { uploadCasAction } from "@/app/(app)/cas/actions";

export const metadata = { title: "Upload CAS" };

export default async function UploadCasPage(props: PageProps<"/clients/[id]/cas/upload">) {
  const { id } = await props.params;
  const { c } = await pageData(async (tx) => ({ c: await getClientSummary(tx, id) }));
  const auto = n8nConfigured.casParse();
  return (
    <>
      <PageHeader title={`Upload CAS · ${c.full_name}`} subtitle="Every CAS creates a NEW snapshot; earlier snapshots are never overwritten. The same file cannot be uploaded twice." />
      <Card className="max-w-2xl">
        <CardContent>
          <ActionForm action={uploadCasAction.bind(null, id)} className="space-y-4">
            <Field label="CAS PDF *" hint="Stored in private storage. Max 25 MB."><Input type="file" name="file" accept="application/pdf" required className="pt-1.5" /></Field>
            <Field label="Source">
              <Select name="source" defaultValue="CAMS">{CAS_SOURCES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</Select>
            </Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="password_protected" value="yes" defaultChecked /> PDF is password protected</label>
            {auto ? (
              <Field label="PDF password (optional)" hint="Sent once to the extraction workflow over HTTPS. It is never stored or logged by this app.">
                <Input type="password" name="password" autoComplete="off" />
              </Field>
            ) : (
              <p className="rounded-md bg-amber-50 p-3 text-xs text-amber-900">
                Automatic extraction is not configured (N8N_CAS_PARSE_WEBHOOK_URL). After upload you can import the extraction JSON manually. Do not type the PDF password here.
              </p>
            )}
            <Field label="Notes"><Textarea name="notes" rows={2} /></Field>
            <SubmitButton>Upload CAS</SubmitButton>
          </ActionForm>
        </CardContent>
      </Card>
    </>
  );
}
