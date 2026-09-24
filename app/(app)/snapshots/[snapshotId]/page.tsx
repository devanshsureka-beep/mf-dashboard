import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Input } from "@/components/ui/form";
import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { HoldingsTable } from "@/components/app/holdings-table";
import { Money } from "@/components/app/money";
import { StatusBadge } from "@/components/app/status-badge";
import { StatCard } from "@/components/app/stat-card";
import { pageData } from "@/lib/server";
import { formatDate, formatDateTime, formatINRCompact, formatUnits, humanize } from "@/lib/format";
import { holdingKey } from "@/lib/domain/reconciliation";
import { getClientSummary } from "@/services/clients";
import { getHoldings, getSnapshot } from "@/services/portfolio";
import { confirmSnapshotAction, rejectSnapshotAction } from "../../cas/actions";

export const metadata = { title: "Snapshot review" };

export default async function SnapshotPage(props: PageProps<"/snapshots/[snapshotId]">) {
  const { snapshotId } = await props.params;
  const { s, holdings, prev, prevHoldings, cas, c } = await pageData(async (tx) => {
    const s = await getSnapshot(tx, snapshotId);
    const prevRows = await tx<{ id: string; snapshot_date: string; total_current_value: number }[]>`
      select id, snapshot_date, total_current_value from public.portfolio_snapshots
      where client_id = ${s.client_id} and review_status = 'CONFIRMED' and id <> ${snapshotId}
        and (snapshot_date, created_at) < (${s.snapshot_date}::date, ${s.created_at})
      order by snapshot_date desc, created_at desc limit 1`;
    const cas = s.cas_document_id
      ? (await tx<{ id: string; parse_warnings: string[]; file_name: string }[]>`
          select cd.id, cd.parse_warnings, d.file_name from public.cas_documents cd join public.documents d on d.id = cd.document_id
          where cd.id = ${s.cas_document_id}`)[0]
      : null;
    return {
      s, cas, c: await getClientSummary(tx, s.client_id),
      holdings: await getHoldings(tx, snapshotId),
      prev: prevRows[0] ?? null,
      prevHoldings: prevRows[0] ? await getHoldings(tx, prevRows[0].id) : [],
    };
  });

  // Quick diff by security (the full matching happens in reconciliation).
  const agg = (rows: typeof holdings) => {
    const m = new Map<string, { name: string; units: number; value: number }>();
    for (const h of rows) {
      const k = holdingKey({ securityId: h.security_id, isin: h.isin, schemeName: h.scheme_name });
      const x = m.get(k) ?? { name: h.scheme_name, units: 0, value: 0 };
      x.units += h.units; x.value += h.current_value; m.set(k, x);
    }
    return m;
  };
  const a = agg(prevHoldings), b = agg(holdings);
  const diff = [...new Set([...a.keys(), ...b.keys()])]
    .map((k) => ({ k, name: b.get(k)?.name ?? a.get(k)!.name, pu: a.get(k)?.units ?? 0, cu: b.get(k)?.units ?? 0, pv: a.get(k)?.value ?? 0, cv: b.get(k)?.value ?? 0 }))
    .filter((d) => Math.abs(d.cu - d.pu) > 0.001);

  return (
    <>
      <div className="mb-4">
        <div className="text-xs text-muted"><Link href={`/clients/${s.client_id}?tab=portfolio`} className="hover:underline">{c.full_name}</Link> / Snapshot</div>
        <h1 className="mt-0.5 flex items-center gap-2 text-xl font-semibold">Portfolio snapshot · {formatDate(s.snapshot_date)} <StatusBadge status={s.review_status} />{s.is_baseline ? <span className="text-xs font-medium text-brand">BASELINE</span> : null}</h1>
        <div className="mt-1 flex flex-wrap gap-x-4 text-sm text-muted">
          <span>Source {humanize(s.source)}</span><span>Extraction {humanize(s.extraction_method)}</span><span>Created {formatDateTime(s.created_at)}</span>
          {cas ? <Link className="text-brand hover:underline" href={`/cas/${cas.id}`}>CAS: {cas.file_name}</Link> : null}
          {s.reviewed_at ? <span>Reviewed {formatDateTime(s.reviewed_at)}{s.review_note ? ` — ${s.review_note}` : ""}</span> : null}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Current value" value={formatINRCompact(s.total_current_value)} />
        <StatCard label="Invested (cost)" value={formatINRCompact(s.total_invested_value)} />
        <StatCard label="Previous confirmed" value={prev ? formatINRCompact(prev.total_current_value) : "—"} hint={prev ? formatDate(prev.snapshot_date) : "This will be the baseline"} />
        <StatCard label="Change vs previous" value={prev ? formatINRCompact(s.total_current_value - prev.total_current_value) : "—"} />
      </div>

      {cas?.parse_warnings?.length ? (
        <div className="mt-4 rounded-md bg-amber-50 p-3 text-sm text-amber-900">
          <strong>Extraction warnings — check against the PDF:</strong>
          <ul className="ml-5 list-disc">{cas.parse_warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div>
      ) : null}

      {s.review_status === "PENDING_REVIEW" ? (
        <Card className="mt-4 border-brand/30">
          <CardHeader><CardTitle>Review extraction</CardTitle></CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <ActionForm action={confirmSnapshotAction.bind(null, snapshotId)} className="space-y-2">
              <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="confirm" value="yes" className="mt-1" /> I checked holdings and totals against the CAS PDF.</label>
              <Input name="note" placeholder="Review note (optional)" />
              <SubmitButton variant="success">Confirm snapshot{prev ? " & reconcile" : " (baseline)"}</SubmitButton>
            </ActionForm>
            <ActionForm action={rejectSnapshotAction.bind(null, snapshotId)} className="space-y-2">
              <Input name="reason" placeholder="Why is this extraction wrong? (required)" required />
              <SubmitButton variant="outline">Reject snapshot</SubmitButton>
            </ActionForm>
          </CardContent>
        </Card>
      ) : null}

      {prev ? (
        <Card className="mt-4">
          <CardHeader><CardTitle>Changes vs {formatDate(prev.snapshot_date)} ({diff.length})</CardTitle></CardHeader>
          {diff.length === 0 ? <CardContent><p className="text-sm text-muted">No unit changes.</p></CardContent> : (
            <Table>
              <THead><TR><TH>Security</TH><TH className="text-right">Previous units</TH><TH className="text-right">New units</TH><TH className="text-right">Difference</TH><TH className="text-right">Previous value</TH><TH className="text-right">New value</TH></TR></THead>
              <TBody>
                {diff.map((d) => (
                  <TR key={d.k}>
                    <TD className="max-w-80 truncate">{d.name}</TD>
                    <TD className="text-right num text-xs">{formatUnits(d.pu)}</TD>
                    <TD className="text-right num text-xs">{formatUnits(d.cu)}</TD>
                    <TD className={`text-right num text-xs font-medium ${d.cu - d.pu < 0 ? "text-red-700" : "text-emerald-700"}`}>{d.cu - d.pu > 0 ? "+" : ""}{formatUnits(d.cu - d.pu)}</TD>
                    <TD className="text-right"><Money value={d.pv} /></TD>
                    <TD className="text-right"><Money value={d.cv} /></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      ) : null}

      <Card className="mt-4">
        <CardHeader><CardTitle>Holdings ({holdings.length})</CardTitle></CardHeader>
        <HoldingsTable rows={holdings} />
      </Card>
    </>
  );
}
