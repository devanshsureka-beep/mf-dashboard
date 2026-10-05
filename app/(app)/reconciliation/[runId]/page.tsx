import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Input } from "@/components/ui/form";
import { Badge } from "@/components/ui/badge";
import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { Money } from "@/components/app/money";
import { ActionBadge, StatusBadge } from "@/components/app/status-badge";
import { StatCard } from "@/components/app/stat-card";
import { EmptyState } from "@/components/app/page-header";
import { pageData } from "@/lib/server";
import { formatDate, formatDateTime, formatINRCompact, formatUnits, humanize } from "@/lib/format";
import { getMatches, getRun, HISTORY_BEFORE_PREVIOUS_CAS, RECORDED_AS_ADVISED } from "@/services/reconciliation";
import type { ReconciliationMatchRow } from "@/types/domain";
import { bulkUnadvisedAction, cancelRunAction, recheckRunAction, resolveMatchAction } from "../actions";
import { UnadvisedReview, type UnadvisedRow } from "./unadvised-review";

export const metadata = { title: "CAS matching run" };

export default async function RunPage(props: PageProps<"/reconciliation/[runId]">) {
  const { runId } = await props.params;
  const { run, matches: allMatches, actor } = await pageData(async (tx) => ({ run: await getRun(tx, runId), matches: await getMatches(tx, runId) }));
  // Rows closed as history (trades before the previous CAS) are not changes.
  const isHistory = (m: ReconciliationMatchRow) => m.status === "REJECTED" && Boolean(m.resolution_note?.startsWith(HISTORY_BEFORE_PREVIOUS_CAS));
  const matches = allMatches.filter((m) => !isHistory(m));
  const historyCount = allMatches.length - matches.length;
  const canAdvise = actor.role !== "OPERATIONS";
  const advice = matches.filter((m) => m.classification === "ADVICE_MATCH");
  const unadvised = matches.filter((m) => m.classification === "UNADVISED");
  const sip = matches.filter((m) => m.classification === "SIP_INSTALMENT");
  const act = (m: ReconciliationMatchRow) => resolveMatchAction.bind(null, runId, m.id);
  const byTxn = allMatches.some((m) => m.cas_transaction_id);
  const unadvisedRows: UnadvisedRow[] = unadvised.map((m) => ({
    id: m.id, scheme_name: m.scheme_name, folio: m.folio_numbers?.[0] ?? null, change_type: m.change_type,
    transaction_date: m.transaction_date, transaction_amount: m.transaction_amount, transaction_units: m.transaction_units,
    transaction_nav: m.transaction_nav, approx_amount: Number(m.approx_amount), system_note: m.system_note, resolution_note: m.resolution_note,
    state: m.status === "REJECTED" ? (m.resolution_note?.startsWith(RECORDED_AS_ADVISED) ? "ADVISED" : "CLOSED") : m.reviewed_at ? "NOT_ADVISED" : "TO_REVIEW",
    reviewed_at: m.reviewed_at ? new Date(m.reviewed_at).toISOString() : null,
    canRecordAdvised: Boolean(m.cas_transaction_id) && Number(m.transaction_amount) > 0,
  }));
  const autoCount = advice.filter((m) => m.auto_confirmed).length;
  const txnCell = (m: ReconciliationMatchRow) => (
    <TD className="text-xs">
      <div className="font-medium">{formatDate(m.transaction_date)}</div>
      <div className={m.change_type === "DECREASE" ? "text-red-700" : "text-emerald-700"}>
        {m.change_type === "DECREASE" ? "Redeemed" : "Invested"} <Money value={m.transaction_amount} full />
      </div>
      <div className="num text-muted">{formatUnits(m.transaction_units)} u @ {m.transaction_nav ?? "—"}</div>
    </TD>
  );

  return (
    <>
      <div className="mb-4">
        <div className="text-xs text-muted"><Link href="/reconciliation" className="hover:underline">Reconciliation</Link> / <Link href={`/clients/${run.client_id}?tab=cas`} className="hover:underline">{run.client_name}</Link></div>
        <h1 className="mt-0.5 flex items-center gap-2 text-xl font-semibold">CAS reconciliation · {run.client_name} <StatusBadge status={run.status} /></h1>
        <div className="mt-1 text-sm text-muted">
          Snapshot {formatDate(run.previous_snapshot_date)} → {formatDate(run.current_snapshot_date)} · created {formatDateTime(run.created_at)}
          · <Link className="text-brand hover:underline" href={`/snapshots/${run.current_snapshot_id}`}>new snapshot</Link>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label="Previous portfolio value" value={formatINRCompact(run.previous_value)} hint={formatDate(run.previous_snapshot_date)} />
        <StatCard label="New portfolio value" value={formatINRCompact(run.current_value)} hint={formatDate(run.current_snapshot_date)} />
        <StatCard label="Advice matches" value={advice.length} hint={`${advice.filter((m) => m.status === "SUGGESTED").length} awaiting decision`} tone={advice.some((m) => m.status === "SUGGESTED") ? "attention" : "default"} />
        <StatCard label="Unadvised to review" value={unadvisedRows.filter((r) => r.state === "TO_REVIEW").length} hint={`of ${unadvised.length} unadvised trade(s)`} tone={unadvisedRows.some((r) => r.state === "TO_REVIEW") ? "danger" : "default"} />
        <StatCard label="SIP instalments" value={sip.length} hint={run.summary.sip_items_completed ? `${run.summary.sip_items_completed} SIP plan action(s) verified` : "Explained by CAS SIP transactions"} />
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>{byTxn ? "CAS transactions matched to calls" : "Detected changes matched to advice"}</CardTitle>
          <span className="text-xs text-muted">
            {byTxn
              ? `${autoCount} clear match${autoCount === 1 ? "" : "es"} confirmed automatically with the CAS date, amount, units and NAV. The rest need your decision.`
              : "Confirming creates or verifies a CAS_VERIFIED execution."}
          </span>
        </CardHeader>
        {advice.length === 0 ? <CardContent><EmptyState title="No changes matched open advice" /></CardContent> : (
          <Table className="text-[13px] [&_td]:px-2 [&_th]:px-2">
            <THead>
              <TR><TH>Security</TH>{byTxn ? <TH>CAS transaction</TH> : <><TH className="text-right">Previous units</TH><TH className="text-right">New units</TH><TH className="text-right">Difference</TH></>}<TH>Matching advice</TH><TH className="text-right">Expected</TH><TH>Confidence</TH><TH>Status</TH><TH>Decision</TH></TR>
            </THead>
            <TBody>
              {advice.map((m) => (
                <TR key={m.id}>
                  <TD className="max-w-56"><div className="truncate font-medium" title={m.scheme_name}>{m.scheme_name}</div><div className="text-[11px] text-muted">{humanize(m.change_type)} · {m.folio_numbers.join(", ")}</div></TD>
                  {byTxn ? txnCell(m) : <>
                  <TD className="text-right num text-xs">{formatUnits(m.previous_units)}</TD>
                  <TD className="text-right num text-xs">{formatUnits(m.current_units)}</TD>
                  <TD className={`text-right num text-xs font-medium ${m.detected_change < 0 ? "text-red-700" : "text-emerald-700"}`}>
                    {m.detected_change > 0 ? "+" : ""}{formatUnits(m.detected_change)}
                    <div className="font-normal text-muted">≈ <Money value={m.approx_amount} /></div>
                  </TD>
                  </>}
                  <TD className="text-xs">
                    <Link href={`/advice/items/${m.advice_item_id}`} className="flex items-center gap-1 hover:underline">
                      {m.advice_action ? <ActionBadge action={m.advice_action} /> : null} {m.advice_batch_code}
                    </Link>
                    <div className="text-muted">{formatDateTime(m.advice_communicated_at)}</div>
                    <div className="text-muted">{m.advice_advised_units ? `${formatUnits(m.advice_advised_units)} units` : <Money value={m.advice_advised_amount} />} · <StatusBadge status={m.advice_status} /></div>
                  </TD>
                  {byTxn
                    ? <TD className="text-right text-xs"><Money value={m.expected_amount} /><div className="text-muted">matched <Money value={m.approx_amount} /></div></TD>
                    : <TD className="text-right num text-xs">{m.expected_change != null ? formatUnits(m.expected_change) : "—"}<div className="text-muted">allocated {formatUnits(m.allocated_units)}</div></TD>}
                  <TD><StatusBadge status={m.confidence} /></TD>
                  <TD>
                    <StatusBadge status={m.status} />
                    {m.auto_confirmed ? <div><Badge tone="success">AUTO</Badge></div> : null}
                    {m.confirmed_amount ? <div className="text-[11px] text-muted"><Money value={m.confirmed_amount} full /></div> : null}
                    {m.resolution_note ? <div className="max-w-40 text-[11px] text-muted">{m.resolution_note}</div> : null}
                  </TD>
                  <TD className="min-w-64">
                    <div className="mb-1 text-[11px] text-muted">{m.system_note}</div>
                    {m.status === "SUGGESTED" ? (
                      <div className="space-y-1.5">
                        <ActionForm action={act(m)} className="flex gap-1">
                          <input type="hidden" name="decision" value="CONFIRM" />
                          <SubmitButton size="sm" variant="success">Confirm match</SubmitButton>
                        </ActionForm>
                        <details>
                          <summary className="cursor-pointer text-xs text-brand">Partial match / reject / unadvised</summary>
                          <div className="mt-1 space-y-2 rounded-md border border-border p-2">
                            <ActionForm action={act(m)} className="flex flex-wrap gap-1">
                              <input type="hidden" name="decision" value="PARTIAL" />
                              <Input name="units" placeholder="Units" className="h-8 w-20 text-xs" required />
                              <Input name="amount" placeholder="₹ (optional)" className="h-8 w-24 text-xs" />
                              <Input name="note" placeholder="Note (required)" className="h-8 w-36 text-xs" required />
                              <SubmitButton size="sm" variant="outline">Partial match</SubmitButton>
                            </ActionForm>
                            <ActionForm action={act(m)} className="flex gap-1">
                              <input type="hidden" name="decision" value="REJECT" />
                              <Input name="note" placeholder="Why not this call? (required)" className="h-8 text-xs" required />
                              <SubmitButton size="sm" variant="outline">Reject</SubmitButton>
                            </ActionForm>
                            <ActionForm action={act(m)} className="flex gap-1">
                              <input type="hidden" name="decision" value="UNADVISED" />
                              <Input name="note" placeholder="Note" className="h-8 text-xs" />
                              <SubmitButton size="sm" variant="danger">Mark unadvised</SubmitButton>
                            </ActionForm>
                          </div>
                        </details>
                      </div>
                    ) : null}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Card className="mt-4 border-red-200">
        <CardHeader><CardTitle className="text-red-700">Unadvised transactions</CardTitle><span className="text-xs text-muted">Trades with no matching call. Search, tick one or many, then say whether you advised them.</span></CardHeader>
        <UnadvisedReview rows={unadvisedRows} canAdvise={canAdvise} act={bulkUnadvisedAction.bind(null, runId)} />
        {historyCount ? <CardContent className="border-t border-border text-xs text-muted">{historyCount} transaction(s) dated on or before the previous CAS were set aside as history (a full-history statement lists past trades again).</CardContent> : null}
      </Card>

      {sip.length ? (
        <Card className="mt-4">
          <CardHeader><CardTitle>Explained by SIP instalments</CardTitle></CardHeader>
          <Table className="text-[13px]">
            <THead><TR><TH>Security</TH><TH className="text-right">Units change</TH><TH className="text-right">Approx. amount</TH><TH>Note</TH></TR></THead>
            <TBody>
              {sip.map((m) => (
                <TR key={m.id}>
                  <TD>{m.scheme_name}</TD>
                  <TD className="text-right num text-xs">+{formatUnits(m.allocated_units)}</TD>
                  <TD className="text-right"><Money value={m.approx_amount} /></TD>
                  <TD className="text-xs text-muted">{m.system_note}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      ) : null}

      {byTxn && run.status !== "CANCELLED" ? (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Re-check this CAS</CardTitle>
            <span className="text-xs text-muted">Matches any transaction of this CAS that has no row above yet. Rows already here, and anything confirmed, stay as they are.</span>
          </CardHeader>
          <CardContent>
            <ActionForm action={recheckRunAction.bind(null, runId)} className="flex gap-2">
              <SubmitButton size="sm" variant="outline">Re-check transactions</SubmitButton>
            </ActionForm>
          </CardContent>
        </Card>
      ) : null}

      {run.status === "OPEN" && !matches.some((m) => m.status === "CONFIRMED" || m.status === "PARTIAL") ? (
        <Card className="mt-4">
          <CardHeader><CardTitle>Cancel run</CardTitle></CardHeader>
          <CardContent>
            <ActionForm action={cancelRunAction.bind(null, runId)} className="flex gap-2">
              <Input name="reason" placeholder="Reason (e.g. wrong snapshot compared)" required className="w-96" />
              <SubmitButton size="sm" variant="outline">Cancel run</SubmitButton>
            </ActionForm>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
