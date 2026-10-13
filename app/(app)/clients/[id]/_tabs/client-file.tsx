import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/form";
import { LinkButton } from "@/components/ui/button";
import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { ClientFields } from "@/components/app/client-form";
import { StatusBadge } from "@/components/app/status-badge";
import { EmptyState } from "@/components/app/page-header";
import { withUserTx, type Actor } from "@/lib/db/tx";
import { formatDateTime, humanize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { listAdvisors } from "@/services/clients";
import { listDocuments } from "@/services/documents";
import type { ClientSummary } from "@/types/domain";
import { reassignAdvisorAction, updateClientAction } from "../../actions";
import { AgreementsTab } from "./agreements";
import { ReportsTab } from "./reports";

const DOC_GROUPS: { key: string; label: string; types: string[] }[] = [
  { key: "CAS", label: "CAS", types: ["CAS"] },
  { key: "REPORT", label: "Advisory reports", types: ["ADVISORY_REPORT"] },
  { key: "AGREEMENT", label: "Agreements", types: ["AGREEMENT"] },
  { key: "PROOF", label: "Execution proofs", types: ["EXECUTION_PROOF"] },
  { key: "OTHER", label: "KYC & other", types: ["KYC", "OTHER"] },
];
const TYPE_TONE: Record<string, string> = {
  CAS: "bg-indigo-50 text-indigo-800", ADVISORY_REPORT: "bg-amber-50 text-amber-800", AGREEMENT: "bg-emerald-50 text-emerald-800",
  EXECUTION_PROOF: "bg-blue-50 text-blue-800",
};

/** Agreements & premium, monthly reports, documents and the client's details, in one place. */
export async function ClientFileTab({ client: c, actor, docType }: { client: ClientSummary; actor: Actor; docType: string | null }) {
  const { docs, advisors } = await withUserTx(actor, async (tx) => ({
    docs: await listDocuments(tx, c.client_id),
    advisors: actor.role === "ADMIN" ? await listAdvisors(tx) : [],
  }));
  const group = DOC_GROUPS.find((g) => g.key === docType) ?? null;
  const shown = group ? docs.filter((d) => group.types.includes(d.document_type)) : docs;
  const canAdvise = actor.role !== "OPERATIONS";
  const chip = (key: string | null, label: string, n: number) => (
    <Link key={label} href={`/clients/${c.client_id}?tab=file${key ? `&doc=${key}` : ""}#documents`} scroll={false}
      className={cn("rounded-full px-2.5 py-1 ring-1", (group?.key ?? null) === key ? "bg-ink text-white ring-ink" : "bg-white ring-border hover:bg-slate-50")}>{label} {n}</Link>
  );

  return (
    <div className="space-y-3">
      <div id="agreements" className="scroll-mt-14"><AgreementsTab clientId={c.client_id} actor={actor} /></div>
      <div id="reports" className="scroll-mt-14"><ReportsTab client={c} /></div>

      <Card id="documents" className="scroll-mt-14">
        <CardHeader>
          <CardTitle>Documents · {docs.length}</CardTitle>
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            {chip(null, "All", docs.length)}
            {DOC_GROUPS.map((g) => chip(g.key, g.label, docs.filter((d) => g.types.includes(d.document_type)).length))}
            <LinkButton size="sm" variant="outline" href={`/clients/${c.client_id}/documents/upload`}>Upload</LinkButton>
            <a href={`/api/clients/${c.client_id}/export`} download className="ml-1 font-medium text-brand hover:underline">Download everything (ZIP)</a>
          </div>
        </CardHeader>
        {shown.length === 0 ? <div className="p-4"><EmptyState title="No documents here" /></div> : (
          <ul className="divide-y divide-border">
            {shown.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-[13px]">
                <span className={cn("rounded px-1.5 py-px text-[10px] font-semibold", TYPE_TONE[d.document_type] ?? "bg-slate-100 text-slate-700")}>{humanize(d.document_type)}</span>
                <a className="min-w-0 flex-1 truncate font-medium hover:underline" href={`/api/documents/${d.id}/download`}>{d.description || d.file_name}</a>
                {d.parse_status !== "NOT_APPLICABLE" ? <StatusBadge status={d.parse_status} /> : null}
                <span className="text-xs text-muted">{formatDateTime(d.created_at)} · {d.uploader_name ?? "integration"}</span>
                <a className="text-xs font-medium text-brand hover:underline" href={`/api/documents/${d.id}/download`}>Download</a>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        {canAdvise ? (
          <Card id="details" className="scroll-mt-14">
            <CardHeader><CardTitle>Client details</CardTitle></CardHeader>
            <CardContent>
              <details>
                <summary className="cursor-pointer text-sm text-brand">Edit details</summary>
                <ActionForm action={updateClientAction.bind(null, c.client_id)} className="mt-3 space-y-3">
                  <ClientFields client={c} />
                  <SubmitButton size="sm">Save details</SubmitButton>
                </ActionForm>
              </details>
            </CardContent>
          </Card>
        ) : null}
        {actor.role === "ADMIN" ? (
          <Card id="advisor" className="scroll-mt-14">
            <CardHeader><CardTitle>Advisor assignment</CardTitle></CardHeader>
            <CardContent>
              <ActionForm action={reassignAdvisorAction.bind(null, c.client_id)} className="space-y-2">
                <Field label="Primary advisor">
                  <Select name="advisor_id" defaultValue={c.advisor_id ?? ""}>
                    {advisors.map((a) => <option key={a.id} value={a.id}>{a.full_name}</option>)}
                  </Select>
                </Field>
                <Input name="reason" placeholder="Reason for change" />
                <SubmitButton size="sm" variant="outline">Reassign</SubmitButton>
              </ActionForm>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
