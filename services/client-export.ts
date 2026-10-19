import { todayIST } from "@/lib/format";
import type { Tx } from "@/lib/db/tx";
import { AppError } from "@/lib/errors";
import { getTimeline } from "@/services/client-record";

/**
 * Everything recorded about one client, for the "Download everything (ZIP)"
 * button: every table row and every summary view, plus the list of stored
 * files. Runs in the user's transaction, so RLS decides what is included.
 */

export interface ExportTable {
  file: string;
  title: string;
  columns: string[];
  rows: Record<string, unknown>[];
}

export interface ExportFile {
  path: string;
  zipName: string;
  type: string;
  uploadedAt: Date;
}

export interface ClientExport {
  client: { id: string; client_code: string; full_name: string };
  tables: ExportTable[];
  files: ExportFile[];
}

// [file, title, source, order by] — fixed list, never user input.
const SOURCES: [string, string, string, string][] = [
  ["01 client.csv", "Client profile", "public.clients where id = $1", "created_at"],
  ["02 advisors.csv", "Advisor assignments", "public.client_advisor_assignments where client_id = $1", "created_at"],
  ["03 agreements.csv", "Agreements", "public.client_agreements where client_id = $1", "created_at"],
  ["04 premium payments.csv", "Premium payments", "public.client_payments where client_id = $1", "created_at"],
  ["05 premium status.csv", "Premium status", "public.v_client_premium where client_id = $1", "1"],
  ["10 plans.csv", "Advisory plans", "public.advisory_plans where client_id = $1", "created_at"],
  ["11 plan lines (progress).csv", "Plan lines with target / advised / executed / pending", "public.v_plan_item_progress where client_id = $1", "1"],
  ["12 plan transition.csv", "Plan transition totals", "public.v_plan_transition where client_id = $1", "1"],
  ["13 SIP lines (progress).csv", "SIP lines with progress", "public.v_sip_item_progress where client_id = $1", "1"],
  ["14 SIP summary.csv", "SIP summary", "public.v_client_sip where client_id = $1", "1"],
  ["15 fresh money.csv", "Fresh money added", "public.client_fresh_money where client_id = $1", "created_at"],
  ["20 calls (advice).csv", "Calls issued, with progress", "public.v_advice_item_progress where client_id = $1", "created_at"],
  ["21 call batches.csv", "Call batches", "public.advice_batches where client_id = $1", "created_at"],
  ["22 executions.csv", "Executions", "public.executions where client_id = $1", "created_at"],
  ["23 pending executions.csv", "Pending executions", "public.v_pending_executions where client_id = $1", "1"],
  ["24 advice to execution timing.csv", "Advice to execution timing", "public.v_advice_execution_timing where client_id = $1", "1"],
  ["30 CAS uploads.csv", "CAS uploads", "public.cas_documents where client_id = $1", "uploaded_at"],
  ["31 portfolio snapshots.csv", "Portfolio snapshots", "public.portfolio_snapshots where client_id = $1", "created_at"],
  ["32 holdings (all snapshots).csv", "Holdings in every snapshot", "public.portfolio_holdings where client_id = $1", "created_at"],
  ["33 holdings today.csv", "Latest holdings at today's NAV", "public.v_holding_live where client_id = $1", "1"],
  ["34 CAS transactions.csv", "Transactions read from CAS", "public.portfolio_transactions where client_id = $1", "created_at"],
  ["35 snapshot changes.csv", "Changes between snapshots", "public.v_snapshot_change where client_id = $1", "1"],
  ["40 reconciliation runs.csv", "Reconciliation runs", "public.reconciliation_runs where client_id = $1", "created_at"],
  ["41 reconciliation matches.csv", "Reconciliation matches (advised vs unadvised)", "public.reconciliation_matches where client_id = $1", "created_at"],
  ["50 notes.csv", "Notes and follow-ups", "public.client_notes where client_id = $1", "created_at"],
  ["51 monthly report notes.csv", "Monthly report notes", "public.client_report_notes where client_id = $1", "created_at"],
  ["60 documents.csv", "Documents register", "public.documents where client_id = $1", "created_at"],
  ["90 audit log.csv", "Audit log (every change)", "public.audit_logs where client_id = $1", "occurred_at"],
];

const FOLDER: Record<string, string> = {
  CAS: "documents/CAS",
  ADVISORY_REPORT: "documents/Advisory reports",
  EXECUTION_PROOF: "documents/Execution proofs",
  KYC: "documents/KYC",
  AGREEMENT: "documents/Agreements",
  OTHER: "documents/Other",
};

// date columns arrive as "YYYY-MM-DD" strings, timestamps as Date
// Dates in file names are Indian dates (an upload at 01:00 IST is that day, not the day before in UTC).
const day = (d: Date | string) => (typeof d === "string" ? d.slice(0, 10) : todayIST(d));
const safeName = (s: string) => s.replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 120) || "file";

export async function gatherClientExport(tx: Tx, clientId: string): Promise<ClientExport> {
  if (!/^[0-9a-f-]{36}$/i.test(clientId)) throw new AppError("Client not found.", "NOT_FOUND");
  const client = (await tx<{ id: string; client_code: string; full_name: string }[]>`
    select id, client_code, full_name from public.clients where id = ${clientId} and deleted_at is null`)[0];
  if (!client) throw new AppError("Client not found.", "NOT_FOUND");

  const tables: ExportTable[] = [];
  for (const [file, title, source, order] of SOURCES) {
    const res = await tx.unsafe(`select * from ${source} order by ${order}`, [clientId]);
    tables.push({ file, title, columns: res.columns.map((c) => c.name), rows: res as unknown as Record<string, unknown>[] });
  }
  const timeline = await getTimeline(tx, clientId, { limit: 100000 });
  tables.push({ file: "00 timeline.csv", title: "Timeline: every event since onboarding", columns: ["at", "kind", "title", "detail", "amount", "who"], rows: timeline as unknown as Record<string, unknown>[] });
  tables.sort((a, b) => a.file.localeCompare(b.file));

  const docs = await tx<{ id: string; document_type: string; file_path: string; file_name: string; created_at: Date; valuation_date: string | null }[]>`
    select d.id, case when exists (select 1 from public.client_agreements ag where ag.document_id = d.id) then 'AGREEMENT' else d.document_type end as document_type, d.file_path, d.file_name, d.created_at, cd.valuation_date
    from public.documents d left join public.cas_documents cd on cd.document_id = d.id
    where d.client_id = ${clientId} and d.deleted_at is null
    order by d.created_at`;
  const used = new Set<string>();
  const files = docs.map((d) => {
    const folder = FOLDER[d.document_type] ?? "documents/Other";
    // CAS file names can hold the CAS password: never reuse them.
    const base = d.document_type === "CAS"
      ? `CAS${d.valuation_date ? ` as of ${day(d.valuation_date)}` : ""}.pdf`
      : safeName(d.file_name);
    let name = `${folder}/${day(d.created_at)} ${base}`;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${folder}/${day(d.created_at)} (${i}) ${base}`;
    used.add(name.toLowerCase());
    return { path: d.file_path, zipName: name, type: d.document_type, uploadedAt: new Date(d.created_at) };
  });
  return { client, tables, files };
}

export function exportReadme(e: ClientExport, by: string, missing: string[]): string {
  const lines = [
    `Univest MF Premium · Advisory Desk — complete client record`,
    ``,
    `Client:      ${e.client.full_name} (${e.client.client_code})`,
    `Exported:    ${new Date().toISOString()} by ${by}`,
    ``,
    `data/  — one CSV per record type (opens in Excel / Google Sheets)`,
    ...e.tables.map((t) => `  ${t.file.padEnd(38)} ${String(t.rows.length).padStart(6)} rows  ${t.title}`),
    ``,
    `documents/ — every stored file (${e.files.length - missing.length} of ${e.files.length})`,
    `  CAS statements keep their original password protection.`,
    ...(missing.length ? [``, `Files that could not be read from storage:`, ...missing.map((m) => `  ${m}`)] : []),
    ``,
    `Plan numbers (target / advised / executed / pending) are taken from the`,
    `same database views the dashboard uses. Amounts are in INR.`,
  ];
  return lines.join("\r\n") + "\r\n";
}
