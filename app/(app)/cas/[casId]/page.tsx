import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Textarea } from "@/components/ui/form";
import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { StatusBadge } from "@/components/app/status-badge";
import { pageData } from "@/lib/server";
import { formatDate, formatDateTime, humanize } from "@/lib/format";
import { n8nConfigured } from "@/lib/integrations/n8n";
import { AppError } from "@/lib/errors";
import type { CasDocumentRow } from "@/types/domain";
import { importCasJsonAction, markCasFailedAction, triggerExtractionAction } from "../actions";

export const metadata = { title: "CAS document" };

const EXAMPLE = `{
  "status": "PARSED",
  "extraction_method": "AI_EXTRACTION",
  "statement": { "source": "CAMS", "valuation_date": "2026-09-23", "statement_from_date": "2020-01-01", "statement_to_date": "2026-09-24", "investor_pan": "ABCDE1234F" },
  "holdings": [
    { "scheme_name": "Example Flexi Cap Fund - Regular Growth", "isin": "INF000000000", "folio_number": "12345/67", "amc": "Example AMC", "plan_type": "REGULAR", "units": 1000.123, "nav": 45.67, "nav_date": "2026-09-23", "current_value": 45675.62, "cost_value": 40000 }
  ],
  "transactions": [
    { "date": "2026-08-07", "type": "SIP", "scheme_name": "Example Flexi Cap Fund - Regular Growth", "isin": "INF000000000", "folio_number": "12345/67", "units": 22.1, "nav": 45.2, "amount": 1000, "balance_units": 1000.123 }
  ],
  "totals": { "current_value": 45675.62 },
  "warnings": []
}`;

export default async function CasDocumentPage(props: PageProps<"/cas/[casId]">) {
  const { casId } = await props.params;
  const { d } = await pageData(async (tx) => {
    const rows = await tx<(CasDocumentRow & { client_name: string; client_code: string; document_id: string })[]>`
      select cd.*, d.file_name, c.full_name as client_name, c.client_code, s.id as snapshot_id, s.review_status as snapshot_review_status
      from public.cas_documents cd join public.documents d on d.id = cd.document_id
      join public.clients c on c.id = cd.client_id
      left join public.portfolio_snapshots s on s.cas_document_id = cd.id
      where cd.id = ${casId}`;
    if (!rows[0]) throw new AppError("CAS not found", "NOT_FOUND");
    return { d: rows[0] };
  });
  const waiting = ["UPLOADED", "PROCESSING", "FAILED"].includes(d.parse_status) && !d.snapshot_id;
  return (
    <>
      <div className="mb-4">
        <div className="text-xs text-muted"><Link href={`/clients/${d.client_id}?tab=cas`} className="hover:underline">{d.client_name}</Link> / CAS</div>
        <h1 className="mt-0.5 flex items-center gap-2 text-xl font-semibold">{d.file_name} <StatusBadge status={d.parse_status} /></h1>
        <div className="mt-1 flex flex-wrap gap-x-4 text-sm text-muted">
          <span>Uploaded {formatDateTime(d.uploaded_at)}</span><span>Source {humanize(d.source)}</span>
          <span>{d.password_protected ? "Password protected" : "Not encrypted"}</span>
          {d.valuation_date ? <span>Valuation {formatDate(d.valuation_date)}</span> : null}
          <a className="text-brand hover:underline" href={`/api/documents/${d.document_id}/download`}>Download PDF</a>
        </div>
      </div>

      {d.parse_status === "PROCESSING" ? <p className="mb-4 rounded-md bg-blue-50 p-3 text-sm text-blue-800">Extraction in progress in n8n. This page updates when the callback arrives.</p> : null}
      {d.parse_error ? <p className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-700"><strong>Error:</strong> {d.parse_error}</p> : null}
      {d.parse_warnings?.length ? (
        <div className="mb-4 rounded-md bg-amber-50 p-3 text-sm text-amber-900">
          <strong>Needs review — validation warnings:</strong>
          <ul className="ml-5 list-disc">{d.parse_warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div>
      ) : null}
      {d.snapshot_id ? (
        <p className="mb-4 text-sm">Snapshot created: <Link className="text-brand hover:underline" href={`/snapshots/${d.snapshot_id}`}>review snapshot</Link> <StatusBadge status={d.snapshot_review_status} /></p>
      ) : null}

      {waiting ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader><CardTitle>Automatic extraction (n8n)</CardTitle></CardHeader>
            <CardContent>
              {n8nConfigured.casParse() ? (
                <ActionForm action={triggerExtractionAction.bind(null, casId)} className="space-y-2">
                  {d.password_protected ? <Field label="PDF password (not stored)"><Input type="password" name="password" autoComplete="off" /></Field> : null}
                  <SubmitButton>Send for extraction</SubmitButton>
                </ActionForm>
              ) : <p className="text-sm text-muted">Not configured. Set N8N_CAS_PARSE_WEBHOOK_URL to enable.</p>}
              <ActionForm action={markCasFailedAction.bind(null, casId)} className="mt-4 flex gap-2 border-t border-border pt-4">
                <Input name="reason" placeholder="Reason (e.g. wrong password, unreadable)" required />
                <SubmitButton variant="outline" size="sm">Mark failed</SubmitButton>
              </ActionForm>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Import extraction JSON manually</CardTitle></CardHeader>
            <CardContent>
              <ActionForm action={importCasJsonAction.bind(null, casId)} className="space-y-2">
                <Textarea name="payload" rows={14} className="font-mono text-xs" placeholder={EXAMPLE} required />
                <p className="text-xs text-muted">Validated with the same contract as the n8n callback (docs/INTEGRATIONS.md). Creates a PENDING_REVIEW snapshot — nothing is final until you confirm it.</p>
                <SubmitButton>Validate &amp; import</SubmitButton>
              </ActionForm>
            </CardContent>
          </Card>
        </div>
      ) : null}
    </>
  );
}
