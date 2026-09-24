import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { PageHeader } from "@/components/app/page-header";
import { pageData } from "@/lib/server";
import { n8nConfigured } from "@/lib/integrations/n8n";
import { getClientSummary } from "@/services/clients";
import { importAdvisoryJsonAction, uploadDocumentAction } from "../actions";

export const metadata = { title: "Upload document" };

const EXAMPLE = `{
  "status": "PARSED",
  "plan": { "plan_name": "Portfolio rebalancing plan", "plan_date": "2026-09-24", "starting_portfolio_value": 1577657 },
  "items": [
    { "action": "SELL", "scheme_name": "Example Silver ETF FoF - Regular", "folio_number": "123/45", "target_amount": 202538, "current_amount": 202538, "reason": "Regular plan; exit" },
    { "action": "SWITCH", "scheme_name": "Example Multi Cap Fund - Regular", "target_amount": 189295, "current_amount": 189295, "switch_to_scheme_name": "Example Multi Cap Fund - Direct" },
    { "action": "BUY", "scheme_name": "Example Multi Cap Fund - Direct Growth", "target_amount": 250000, "target_weight": 15.8 }
  ],
  "sip_items": [
    { "action": "STOP", "scheme_name": "Example Multi Cap Fund - Regular", "old_amount": 2500, "debit_day": 8 },
    { "action": "START", "scheme_name": "Example Multi Cap Fund - Direct Growth", "new_amount": 1500 }
  ],
  "declared_totals": { "exit_value": 391833, "buy_value": 250000, "sip_value": 1500 },
  "warnings": []
}`;

export default async function UploadDocumentPage(props: PageProps<"/clients/[id]/documents/upload">) {
  const { id } = await props.params;
  const { c, actor } = await pageData(async (tx) => ({ c: await getClientSummary(tx, id) }));
  const canAdvise = actor.role !== "OPERATIONS";
  return (
    <>
      <PageHeader title={`Upload document · ${c.full_name}`} subtitle="Private storage; duplicate files are rejected by SHA-256. CAS statements are uploaded from the CAS page." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Upload file</CardTitle></CardHeader>
          <CardContent>
            <ActionForm action={uploadDocumentAction.bind(null, id)} className="space-y-3">
              <Field label="Type">
                <Select name="document_type" defaultValue="ADVISORY_REPORT">
                  <option value="ADVISORY_REPORT">Advisory report</option><option value="EXECUTION_PROOF">Execution proof</option>
                  <option value="KYC">KYC</option><option value="OTHER">Other</option>
                </Select>
              </Field>
              <Field label="File *"><Input type="file" name="file" required className="pt-1.5" accept="application/pdf,image/png,image/jpeg,application/json,text/csv" /></Field>
              <Field label="Description"><Input name="description" /></Field>
              {n8nConfigured.advisoryParse() ? (
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="extract" value="yes" defaultChecked /> Send advisory reports for extraction (creates a DRAFT plan for review)</label>
              ) : <p className="text-xs text-muted">Advisory-report extraction webhook not configured — use the JSON import on the right.</p>}
              <SubmitButton>Upload</SubmitButton>
            </ActionForm>
          </CardContent>
        </Card>
        {canAdvise ? (
          <Card>
            <CardHeader><CardTitle>Import advisory report extraction (JSON)</CardTitle></CardHeader>
            <CardContent>
              <ActionForm action={importAdvisoryJsonAction.bind(null, id)} className="space-y-2">
                <Textarea name="payload" rows={16} className="font-mono text-xs" placeholder={EXAMPLE} required />
                <p className="text-xs text-muted">Creates a DRAFT plan. Securities are matched by ISIN or unambiguous name; anything uncertain is flagged &quot;needs review&quot; and blocks approval until resolved.</p>
                <SubmitButton>Validate &amp; create DRAFT plan</SubmitButton>
              </ActionForm>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </>
  );
}
