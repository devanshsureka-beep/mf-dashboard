"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/form";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { pairDocuments } from "@/lib/domain/doc-pairing";
import { identifyBulkFileAction, onboardBulkPairAction, type BulkFileInfo, type BulkOnboardRow } from "./actions";

type Result = BulkOnboardRow | { outcome: "QUEUED" | "WORKING" };

const TONE: Record<Result["outcome"], "success" | "info" | "pending" | "danger" | "neutral" | "muted"> = {
  ONBOARDED: "success", NEEDS_REVIEW: "pending", ALREADY: "muted", FAILED: "danger", QUEUED: "neutral", WORKING: "info",
};
const LABEL: Record<Result["outcome"], string> = {
  ONBOARDED: "Onboarded", NEEDS_REVIEW: "Needs review", ALREADY: "Already done", FAILED: "Failed", QUEUED: "Queued", WORKING: "Working…",
};
const done = (r: Result | undefined) => r?.outcome === "ONBOARDED" || r?.outcome === "ALREADY";

/** Run `fn` over `items` with at most `n` at a time. */
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

export function BulkOnboarder({ advisors, defaultAdvisorId }: { advisors: { id: string; full_name: string; role: string }[]; defaultAdvisorId: string }) {
  const [files, setFiles] = useState<File[]>([]);
  const [infos, setInfos] = useState<(BulkFileInfo | null)[]>([]);
  const [reading, setReading] = useState(false);
  const [pairs, setPairs] = useState<{ cas: number; report: number | null }[]>([]);
  const [results, setResults] = useState<Record<number, Result>>({});
  const [running, setRunning] = useState(false);
  const [advisorId, setAdvisorId] = useState(defaultAdvisorId);
  const [open, setOpen] = useState<number | null>(null);

  function choose(list: FileList | null) {
    const pdfs = Array.from(list ?? []).filter((f) => /\.pdf$/i.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
    setFiles(pdfs);
    setInfos([]);
    setPairs([]);
    setResults({});
  }

  async function readAll() {
    setReading(true);
    const got: (BulkFileInfo | null)[] = files.map(() => null);
    setInfos([...got]);
    await pool(files.map((_, i) => i), 3, async (i) => {
      const fd = new FormData();
      fd.set("file", files[i]);
      try {
        got[i] = await identifyBulkFileAction(fd);
      } catch {
        got[i] = { fileName: files[i].name, kind: "UNREADABLE", name: null, panMasked: null, casDate: null, readerOk: false, existingClient: null, message: "Upload failed (network or file too large)." };
      }
      setInfos([...got]);
    });
    const ids = (k: BulkFileInfo["kind"]) => got.flatMap((x, i) => (x?.kind === k ? [i] : []));
    const p = pairDocuments(
      ids("CAS").map((i) => ({ id: String(i), investorName: got[i]!.name, fileName: files[i].name })),
      ids("REPORT").map((i) => ({ id: String(i), clientName: got[i]!.name, fileName: files[i].name })),
    );
    setPairs(p.map((x) => ({ cas: Number(x.casId), report: x.reportId === null ? null : Number(x.reportId) })));
    setReading(false);
  }

  async function onboard(only?: number) {
    setRunning(true);
    const todo = pairs.filter((p) => p.report !== null && (only === undefined ? !done(results[p.cas]) : p.cas === only));
    setResults((r) => ({ ...r, ...Object.fromEntries(todo.map((p) => [p.cas, { outcome: "QUEUED" as const }])) }));
    for (const p of todo) {
      setResults((r) => ({ ...r, [p.cas]: { outcome: "WORKING" } }));
      const fd = new FormData();
      fd.set("cas", files[p.cas]);
      fd.set("report", files[p.report!]);
      if (advisorId) fd.set("advisor_id", advisorId);
      let res: Result;
      try {
        res = await onboardBulkPairAction(fd);
      } catch {
        res = { outcome: "FAILED", message: "The request failed (network, timeout or file too large). Retry this client.", problems: [], usedClaude: false, corrections: [] };
      }
      setResults((r) => ({ ...r, [p.cas]: res }));
    }
    setRunning(false);
  }

  const reports = useMemo(() => infos.flatMap((x, i) => (x?.kind === "REPORT" ? [i] : [])), [infos]);
  const usedReports = new Map<number, number>();
  for (const p of pairs) if (p.report !== null) usedReports.set(p.report, (usedReports.get(p.report) ?? 0) + 1);
  const others = infos.flatMap((x, i) => (x && (x.kind === "LOCKED" || x.kind === "UNREADABLE" || (x.kind === "REPORT" && !usedReports.has(i))) ? [i] : []));
  const readCount = infos.filter(Boolean).length;
  const ready = pairs.filter((p) => p.report !== null && !done(results[p.cas])).length;
  const tally = (o: Result["outcome"]) => Object.values(results).filter((r) => r.outcome === o).length;

  return (
    <Card>
      <CardHeader><CardTitle>Client folder</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Folder with all CAS + report PDFs</span>
            <input
              type="file" multiple disabled={reading || running}
              {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
              onChange={(e) => choose(e.target.files)}
              className="block text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-white file:px-3 file:py-1.5 file:text-sm"
            />
          </label>
          <span className="pb-2 text-xs text-muted">or</span>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Pick PDFs</span>
            <input
              type="file" accept="application/pdf" multiple disabled={reading || running}
              onChange={(e) => choose(e.target.files)}
              className="block text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-white file:px-3 file:py-1.5 file:text-sm"
            />
          </label>
          <Button onClick={readAll} disabled={reading || running || files.length === 0}>
            {reading ? `Reading ${readCount} of ${files.length}…` : `1. Read ${files.length || ""} file${files.length === 1 ? "" : "s"}`}
          </Button>
        </div>

        {pairs.length ? (
          <>
            <div className="flex flex-wrap items-end gap-3 border-t border-border pt-4">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted">Primary advisor for new clients</span>
                <Select value={advisorId} onChange={(e) => setAdvisorId(e.target.value)} disabled={running} className="w-64">
                  <option value="">Choose advisor…</option>
                  {advisors.map((a) => <option key={a.id} value={a.id}>{a.full_name} ({a.role.toLowerCase()})</option>)}
                </Select>
              </label>
              <Button onClick={() => onboard()} disabled={running || reading || ready === 0 || !advisorId}>
                {running ? "Onboarding…" : `2. Onboard ${ready} client${ready === 1 ? "" : "s"}`}
              </Button>
              <span className="pb-2 text-xs text-muted">
                {tally("ONBOARDED")} onboarded · {tally("NEEDS_REVIEW")} need review · {tally("FAILED")} failed · {tally("ALREADY")} already done
              </span>
            </div>

            <Table className="text-[13px]">
              <THead><TR><TH>Client (from CAS)</TH><TH>CAS</TH><TH>Advisory report</TH><TH>Result</TH><TH /></TR></THead>
              <TBody>
                {pairs.map((p) => {
                  const c = infos[p.cas]!;
                  const r = results[p.cas];
                  const dupe = p.report !== null && (usedReports.get(p.report) ?? 0) > 1;
                  const row = r && "message" in r ? r : null;
                  return (
                    <TR key={p.cas} className="align-top">
                      <TD>
                        <div className="font-medium text-ink">{c.name ?? "Unknown investor"}</div>
                        <div className="text-[11px] text-muted">PAN {c.panMasked ?? "—"}{c.existingClient ? ` · existing: ${c.existingClient}` : ""}</div>
                        {c.message ? <div className="text-[11px] text-red-700">{c.message}</div> : null}
                      </TD>
                      <TD className="max-w-48">
                        <div className="truncate" title={files[p.cas].name}>{files[p.cas].name}</div>
                        <div className="text-[11px] text-muted">valued {c.casDate ?? "—"}</div>
                      </TD>
                      <TD className="max-w-64">
                        <Select
                          value={p.report ?? ""} disabled={running || done(r)}
                          onChange={(e) => setPairs((all) => all.map((x) => (x.cas === p.cas ? { ...x, report: e.target.value === "" ? null : Number(e.target.value) } : x)))}
                          className="w-full text-xs"
                        >
                          <option value="">— no report —</option>
                          {reports.map((i) => <option key={i} value={i}>{infos[i]!.name ? `${infos[i]!.name} · ` : ""}{files[i].name}</option>)}
                        </Select>
                        {p.report !== null && !infos[p.report]!.readerOk ? <div className="mt-0.5 text-[11px] text-amber-700">New layout: Claude will read it.</div> : null}
                        {dupe ? <div className="mt-0.5 text-[11px] text-red-700">This report is also chosen for another CAS.</div> : null}
                      </TD>
                      <TD className="max-w-md">
                        {r ? <Badge tone={TONE[r.outcome]}>{LABEL[r.outcome]}</Badge> : <span className="text-xs text-muted">{p.report === null ? "No report" : "Ready"}</span>}
                        {row?.usedClaude ? <Badge tone="info" className="ml-1">Claude</Badge> : null}
                        {row ? <div className="mt-1 text-xs text-muted">{row.message}</div> : null}
                        {row && (row.problems.length || row.corrections.length) ? (
                          <button className="mt-1 text-xs text-brand hover:underline" onClick={() => setOpen(open === p.cas ? null : p.cas)}>
                            {open === p.cas ? "Hide details" : `Details (${row.problems.length} point${row.problems.length === 1 ? "" : "s"}${row.corrections.length ? `, ${row.corrections.length} correction${row.corrections.length === 1 ? "" : "s"} by Claude` : ""})`}
                          </button>
                        ) : null}
                        {row && open === p.cas ? (
                          <div className="mt-1 space-y-2 text-xs">
                            {row.problems.length ? <ol className="list-decimal space-y-0.5 pl-4 text-red-800">{row.problems.map((x, i) => <li key={i}>{x}</li>)}</ol> : null}
                            {row.corrections.length ? (
                              <div>
                                <div className="font-medium text-ink">Corrected by Claude</div>
                                <ul className="list-disc space-y-0.5 pl-4 text-muted">{row.corrections.map((x, i) => <li key={i}>{x}</li>)}</ul>
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </TD>
                      <TD className="whitespace-nowrap text-xs">
                        {row?.planId && row.clientId ? <Link className="text-brand hover:underline" href={`/clients/${row.clientId}/plans/${row.planId}`}>Plan →</Link>
                          : row?.clientId ? <Link className="text-brand hover:underline" href={`/clients/${row.clientId}`}>Client →</Link>
                          : null}
                        {r && !done(r) && r.outcome !== "WORKING" && r.outcome !== "QUEUED" && !running && p.report !== null ? (
                          <button className="ml-2 text-brand hover:underline" onClick={() => onboard(p.cas)} disabled={!advisorId}>Retry</button>
                        ) : null}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </>
        ) : null}

        {!reading && others.length ? (
          <div className="border-t border-border pt-3">
            <div className="mb-1 text-xs font-medium text-ink">Other files</div>
            <ul className="space-y-0.5 text-xs text-muted">
              {others.map((i) => (
                <li key={i}>
                  <span className="text-ink">{files[i].name}</span>
                  {" — "}
                  {infos[i]!.kind === "REPORT" ? `report${infos[i]!.name ? ` for ${infos[i]!.name}` : ""}, not paired with any CAS` : infos[i]!.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
