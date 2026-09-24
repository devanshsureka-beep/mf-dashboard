import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import { AuditTable } from "@/components/app/audit-table";
import { EmptyState, PageHeader } from "@/components/app/page-header";
import { humanize } from "@/lib/format";
import { pageData } from "@/lib/server";
import { listAuditLogs } from "@/services/audit";
import { listClientSummaries } from "@/services/clients";

export const metadata = { title: "Audit log" };

const ENTITIES = [
  "advice_items", "advice_batches", "executions", "advisory_plans", "advisory_plan_items", "sip_plan_items",
  "portfolio_snapshots", "cas_documents", "reconciliation_matches", "reconciliation_runs", "clients",
  "client_advisor_assignments", "profiles", "documents", "client_notes", "security_master",
];

export default async function AuditPage(props: PageProps<"/audit">) {
  const sp = await props.searchParams;
  const one = (k: string) => (typeof sp[k] === "string" && sp[k] ? (sp[k] as string) : null);
  const f = { clientId: one("client"), entityType: one("entity"), from: one("from"), to: one("to"), entityId: one("entity_id") };
  const { rows, clients } = await pageData(async (tx) => ({
    rows: await listAuditLogs(tx, { ...f, limit: 500 }),
    clients: await listClientSummaries(tx),
  }), ["ADMIN"]);
  return (
    <>
      <PageHeader title="Audit log" subtitle="Append-only. Written by database triggers for every change to financial records; cannot be edited or deleted by anyone." />
      <form method="get" className="sticky top-0 z-20 mb-4 flex flex-wrap items-end gap-2 rounded-lg border border-border bg-white/95 p-3 backdrop-blur">
        <Select name="client" defaultValue={f.clientId ?? ""} className="w-56">
          <option value="">All clients</option>
          {clients.map((c) => <option key={c.client_id} value={c.client_id}>{c.full_name}</option>)}
        </Select>
        <Select name="entity" defaultValue={f.entityType ?? ""} className="w-56">
          <option value="">All record types</option>
          {ENTITIES.map((e) => <option key={e} value={e}>{humanize(e)}</option>)}
        </Select>
        <label className="text-xs text-muted">From<Input type="date" name="from" defaultValue={f.from ?? ""} className="w-40" /></label>
        <label className="text-xs text-muted">To<Input type="date" name="to" defaultValue={f.to ?? ""} className="w-40" /></label>
        <Input name="entity_id" placeholder="Record id (uuid)" defaultValue={f.entityId ?? ""} className="w-72" />
        <Button type="submit" variant="outline">Filter</Button>
        <Link href="/audit" className="px-2 text-xs text-muted hover:underline">Reset</Link>
      </form>
      <Card>{rows.length ? <AuditTable rows={rows} showClient /> : <CardContent><EmptyState title="No audit entries match" /></CardContent>}</Card>
    </>
  );
}
