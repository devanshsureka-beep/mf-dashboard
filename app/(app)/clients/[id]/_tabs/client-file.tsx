import { Field, Input, Select } from "@/components/ui/form";
import { Button, LinkButton } from "@/components/ui/button";
import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { ClientFields } from "@/components/app/client-form";
import { StatusBadge } from "@/components/app/status-badge";
import { withUserTx, type Actor } from "@/lib/db/tx";
import { formatDateTime, humanize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { listAdvisors } from "@/services/clients";
import { casLabel, listDocuments } from "@/services/documents";
import type { ClientSummary } from "@/types/domain";
import { reassignAdvisorAction, updateClientAction } from "../../actions";
import { AgreementsTab } from "./agreements";
import { ReportsTab } from "./reports";
import { NotesPanel } from "./notes";

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

/** Premium, agreement and reports tiles, documents, notes & follow-ups, and the client's details folded away. */
export async function ClientFileTab({ client: c, actor, docType, open }: { client: ClientSummary; actor: Actor; docType: string | null; open: string | null }) {
  const { docs, advisors } = await withUserTx(actor, async (tx) => ({
    docs: await listDocuments(tx, c.client_id),
    advisors: actor.role === "ADMIN" ? await listAdvisors(tx) : [],
  }));
  const group = DOC_GROUPS.find((g) => g.key === docType) ?? null;
  const shown = group ? docs.filter((d) => group.types.includes(d.document_type)) : docs;
  const canAdvise = actor.role !== "OPERATIONS";
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-3">
        <AgreementsTab clientId={c.client_id} actor={actor} open={open} />
        <ReportsTab client={c} />
      </div>

      <section id="documents" className="scroll-mt-14 overflow-hidden rounded-xl border border-border bg-surface">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
          <h3 className="text-sm font-semibold">Documents · {docs.length}</h3>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <form method="get" className="flex items-center gap-1.5">
              <input type="hidden" name="tab" value="file" />
              <Select name="doc" defaultValue={group?.key ?? ""} className="h-8 w-40 text-xs" aria-label="Document type">
                <option value="">All types · {docs.length}</option>
                {DOC_GROUPS.map((g) => <option key={g.key} value={g.key}>{g.label} · {docs.filter((d) => g.types.includes(d.document_type)).length}</option>)}
              </Select>
              <Button type="submit" size="sm" variant="ghost">Show</Button>
            </form>
            <LinkButton size="sm" variant="outline" href={`/clients/${c.client_id}/documents/upload`}>Upload</LinkButton>
            <a href={`/api/clients/${c.client_id}/export`} download className="font-medium text-brand hover:underline">Download everything (ZIP)</a>
          </div>
        </div>
        {shown.length === 0 ? <p className="border-t border-border px-4 py-3 text-sm text-muted">No documents{group ? " of this type" : " yet"}.</p> : (
          <ul className="divide-y divide-border border-t border-border">
            {shown.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-[13px]">
                <span className={cn("rounded px-1.5 py-px text-[10px] font-semibold", TYPE_TONE[d.document_type] ?? "bg-slate-100 text-slate-700")}>{humanize(d.document_type)}</span>
                <a className="min-w-0 flex-1 truncate font-medium hover:underline" href={`/api/documents/${d.id}/download`}>{d.document_type === "CAS" ? casLabel(d.valuation_date) : d.description || d.file_name}</a>
                {d.parse_status !== "NOT_APPLICABLE" ? <StatusBadge status={d.parse_status} /> : null}
                <span className="text-xs text-muted">{formatDateTime(d.created_at)} · {d.uploader_name ?? "integration"}</span>
                <a className="text-xs font-medium text-brand hover:underline" href={`/api/documents/${d.id}/download`}>Download</a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <NotesPanel clientId={c.client_id} actor={actor} />

      {canAdvise || actor.role === "ADMIN" ? (
        <details id="details" open={open === "details"} className="scroll-mt-14 rounded-xl border border-border bg-surface">
          <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-semibold">Client details &amp; advisor</summary>
          <div className="grid gap-4 border-t border-border p-4 lg:grid-cols-2">
            {canAdvise ? (
              <div>
                <div className="mb-2 text-sm font-medium">Edit details <span className="font-normal text-muted">(phone, email, goal, risk)</span></div>
                <ActionForm action={updateClientAction.bind(null, c.client_id)} className="space-y-3">
                  <ClientFields client={c} />
                  <SubmitButton size="sm">Save details</SubmitButton>
                </ActionForm>
              </div>
            ) : null}
            {actor.role === "ADMIN" ? (
              <div id="advisor">
                <div className="mb-2 text-sm font-medium">Primary advisor</div>
                <ActionForm action={reassignAdvisorAction.bind(null, c.client_id)} className="space-y-2">
                  <Field label="Advisor">
                    <Select name="advisor_id" defaultValue={c.advisor_id ?? ""}>
                      {advisors.map((a) => <option key={a.id} value={a.id}>{a.full_name}</option>)}
                    </Select>
                  </Field>
                  <Input name="reason" placeholder="Reason for change" />
                  <SubmitButton size="sm" variant="outline">Reassign</SubmitButton>
                </ActionForm>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  );
}
