"use client";

import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/form";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { processCasFileAction, type BulkCasRow } from "./actions";

type Row = BulkCasRow | { ok: null; fileName: string; outcome: "QUEUED" | "WORKING"; message: string };

const TONE: Record<Row["outcome"], "success" | "info" | "pending" | "danger" | "neutral" | "muted"> = {
  RECONCILED: "success", BASELINE: "info", NEEDS_REVIEW: "pending", DUPLICATE: "muted",
  NO_CLIENT: "danger", ERROR: "danger", QUEUED: "neutral", WORKING: "info",
};
const LABEL: Record<Row["outcome"], string> = {
  RECONCILED: "Updated", BASELINE: "Baseline", NEEDS_REVIEW: "Check snapshot", DUPLICATE: "Duplicate",
  NO_CLIENT: "No client", ERROR: "Failed", QUEUED: "Queued", WORKING: "Reading…",
};

export function BulkUploader() {
  const [files, setFiles] = useState<File[]>([]);
  const [password, setPassword] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);

  async function run(list: File[], retryIndex?: number) {
    setBusy(true);
    const start = retryIndex ?? 0;
    if (retryIndex === undefined) setRows(list.map((f) => ({ ok: null, fileName: f.name, outcome: "QUEUED", message: "" })));
    for (let i = start; i < (retryIndex === undefined ? list.length : retryIndex + 1); i++) {
      setRows((r) => r.map((x, j) => (j === i ? { ok: null, fileName: list[i].name, outcome: "WORKING", message: "" } : x)));
      const fd = new FormData();
      fd.set("file", list[i]);
      if (password) fd.set("password", password);
      let res: Row;
      try {
        res = await processCasFileAction(fd);
      } catch {
        res = { ok: false, fileName: list[i].name, outcome: "ERROR", message: "Upload failed (network or file too large)." };
      }
      setRows((r) => r.map((x, j) => (j === i ? res : x)));
    }
    setBusy(false);
  }

  const done = rows.filter((r) => r.ok !== null);
  const totals = {
    updated: rows.filter((r) => r.outcome === "RECONCILED" || r.outcome === "BASELINE").length,
    review: rows.filter((r) => r.outcome === "NEEDS_REVIEW").length,
    failed: rows.filter((r) => r.outcome === "ERROR" || r.outcome === "NO_CLIENT").length,
  };

  return (
    <Card>
      <CardHeader><CardTitle>Files</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">CAS PDFs (select many)</span>
            <input
              type="file" accept="application/pdf" multiple disabled={busy}
              onChange={(e) => { setFiles(Array.from(e.target.files ?? [])); setRows([]); }}
              className="block text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-white file:px-3 file:py-1.5 file:text-sm"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Password or mobile no. (optional, for files that don&apos;t open)</span>
            <Input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} className="w-72" disabled={busy} />
          </label>
          <Button onClick={() => run(files)} disabled={busy || files.length === 0}>
            {busy ? `Processing ${done.length + 1} of ${rows.length}…` : `Process ${files.length || ""} file${files.length === 1 ? "" : "s"}`}
          </Button>
        </div>

        {rows.length ? (
          <>
            <div className="text-xs text-muted">{totals.updated} updated · {totals.review} to check · {totals.failed} failed · {rows.length} total</div>
            <Table className="text-[13px]">
              <THead><TR><TH>File</TH><TH>Client</TH><TH>CAS date</TH><TH>Result</TH><TH>Details</TH><TH /></TR></THead>
              <TBody>
                {rows.map((r, i) => (
                  <TR key={`${r.fileName}-${i}`}>
                    <TD className="max-w-48 truncate" title={r.fileName}>{r.fileName}</TD>
                    <TD>{"clientId" in r && r.clientId ? <Link className="hover:underline" href={`/clients/${r.clientId}`}>{r.clientName}<div className="text-[11px] text-muted">{r.clientCode}</div></Link> : "—"}</TD>
                    <TD className="whitespace-nowrap text-xs">{"valuationDate" in r && r.valuationDate ? r.valuationDate : "—"}</TD>
                    <TD><Badge tone={TONE[r.outcome]}>{LABEL[r.outcome]}</Badge></TD>
                    <TD className="max-w-md text-xs text-muted">{r.message}</TD>
                    <TD className="whitespace-nowrap text-xs">
                      {"runId" in r && r.runId ? <Link className="text-brand hover:underline" href={`/reconciliation/${r.runId}`}>Review →</Link>
                        : "snapshotId" in r && r.snapshotId ? <Link className="text-brand hover:underline" href={`/snapshots/${r.snapshotId}`}>Snapshot →</Link>
                        : r.outcome === "ERROR" && !busy ? <button className="text-brand hover:underline" onClick={() => run(files, i)}>Retry</button>
                        : null}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
