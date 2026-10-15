"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { transportError } from "@/lib/safe-action";
import { stageLargeFiles } from "@/lib/stage-files";
import { Button, LinkButton } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { pairDocuments } from "@/lib/domain/doc-pairing";
import { identifyBulkFileAction, onboardBulkPairAction, type BulkFileInfo, type BulkOnboardRow, type DraftSummary } from "./client-actions";

type Kind = "AUTO" | "FULL" | "ADDITIONAL";
const KIND_LABEL: Record<Kind, string> = { AUTO: "Auto-detect", FULL: "Full rebalancing", ADDITIONAL: "Additional money (fresh money)" };

type Result = BulkOnboardRow | { outcome: "QUEUED" | "WORKING" };
/** One client: a CAS and its report (either may be missing). */
interface Row { key: string; cas: number | null; report: number | null; kind: Kind; fresh: string; skip: boolean; onlyTwo: boolean }

const done = (r: Result | undefined) => r?.outcome === "ONBOARDED" || r?.outcome === "ALREADY";
const busy = (r: Result | undefined) => r?.outcome === "QUEUED" || r?.outcome === "WORKING";
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Run `fn` over `items` with at most `n` at a time. */
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

/** Every file of a drop, folders included. */
async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  type Entry = { isFile: boolean; isDirectory: boolean; file?: (cb: (f: File) => void, err: () => void) => void; createReader?: () => { readEntries: (cb: (e: Entry[]) => void, err: () => void) => void } };
  const entries = Array.from(dt.items ?? []).map((i) => (i as DataTransferItem & { webkitGetAsEntry?: () => Entry | null }).webkitGetAsEntry?.() ?? null);
  if (!entries.some(Boolean)) return Array.from(dt.files);
  const out: File[] = [];
  const walk = async (e: Entry): Promise<void> => {
    if (e.isFile && e.file) {
      out.push(await new Promise<File>((res, rej) => e.file!(res, rej)));
    } else if (e.isDirectory && e.createReader) {
      const reader = e.createReader();
      for (;;) {
        const batch = await new Promise<Entry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const x of batch) await walk(x);
      }
    }
  };
  for (const e of entries) if (e) await walk(e);
  return out;
}

function draftLine(d: DraftSummary | undefined): string {
  if (!d) return "Draft ready.";
  const parts = [d.sells ? plural(d.sells, "sell") : null, d.buys ? plural(d.buys, "buy") : null, d.sipLines ? plural(d.sipLines, "SIP line") : null, d.keeps ? `${d.keeps} keep` : null].filter(Boolean);
  return `Draft ready${parts.length ? `: ${parts.join(", ")}` : ""}.`;
}

export function ClientOnboarder({ advisors, defaultAdvisorId, advisorRequired, canChooseAdvisor, aiReady, templateSet }: {
  advisors: { id: string; full_name: string; role: string }[];
  defaultAdvisorId: string;
  /** Operations must name the advisor who approves. */
  advisorRequired: boolean;
  canChooseAdvisor: boolean;
  aiReady: boolean;
  templateSet: boolean;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [infos, setInfos] = useState<(BulkFileInfo | null)[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [results, setResults] = useState<Record<string, Result>>({});
  const [reading, setReading] = useState(false);
  const [running, setRunning] = useState(false);
  const [started, setStarted] = useState(false);
  const [advisorId, setAdvisorId] = useState(defaultAdvisorId);
  const [password, setPassword] = useState("");
  const [over, setOver] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  /** Pair CAS with reports by the names inside them; two lone files pair with each other. */
  function buildRows(all: (BulkFileInfo | null)[], prev: Row[]): Row[] {
    const ids = (k: BulkFileInfo["kind"]) => all.flatMap((x, i) => (x?.kind === k ? [i] : []));
    const cas = ids("CAS");
    const reports = ids("REPORT");
    const p = pairDocuments(
      cas.map((i) => ({ id: String(i), investorName: all[i]!.name, fileName: all[i]!.fileName })),
      reports.map((i) => ({ id: String(i), clientName: all[i]!.name, fileName: all[i]!.fileName })),
    );
    const pairs = p.map((x) => ({ cas: Number(x.casId), report: x.reportId === null ? null : Number(x.reportId), onlyTwo: false }));
    const used = new Set(pairs.flatMap((x) => (x.report === null ? [] : [x.report])));
    const lone = reports.filter((r) => !used.has(r));
    const unpaired = pairs.filter((x) => x.report === null);
    if (unpaired.length === 1 && lone.length === 1) {
      unpaired[0].report = lone[0];
      unpaired[0].onlyTwo = true;
      lone.length = 0;
    }
    const keep = (key: string) => prev.find((r) => r.key === key);
    return [
      ...pairs.map((x) => {
        const key = `c${x.cas}`;
        const old = keep(key);
        return { key, cas: x.cas, report: x.report, onlyTwo: x.onlyTwo, kind: old?.kind ?? "AUTO", fresh: old?.fresh ?? "", skip: old?.skip ?? false };
      }),
      ...lone.map((r) => ({ key: `r${r}`, cas: null, report: r, onlyTwo: false, kind: "AUTO" as Kind, fresh: "", skip: false })),
    ];
  }

  async function add(list: File[]) {
    const picked = list.filter((f) => /\.pdf$/i.test(f.name) && !files.some((x) => x.name === f.name && x.size === f.size));
    if (!picked.length) return;
    const all = [...files, ...picked];
    const got: (BulkFileInfo | null)[] = [...infos, ...picked.map(() => null)];
    setFiles(all);
    setInfos([...got]);
    setReading(true);
    await pool(picked.map((_, k) => files.length + k), 3, async (i) => {
      const fd = new FormData();
      fd.set("file", all[i]);
      if (password) fd.set("password", password);
      try {
        await stageLargeFiles(fd);
        got[i] = await identifyBulkFileAction(fd);
      } catch (e) {
        got[i] = { fileName: all[i].name, kind: "UNREADABLE", name: null, panMasked: null, casDate: null, reportDate: null, readerOk: false, existingClient: null, message: transportError(e) };
      }
      setInfos([...got]);
    });
    setRows((prev) => buildRows(got, prev));
    setReading(false);
  }

  /** Locked files again, now with the typed password. */
  async function rereadLocked() {
    const locked = infos.flatMap((x, i) => (x?.kind === "LOCKED" ? [i] : []));
    if (!locked.length) return;
    const got = [...infos];
    setReading(true);
    await pool(locked, 3, async (i) => {
      const fd = new FormData();
      fd.set("file", files[i]);
      if (password) fd.set("password", password);
      try {
        await stageLargeFiles(fd);
        got[i] = await identifyBulkFileAction(fd);
      } catch (e) {
        got[i] = { ...got[i]!, message: transportError(e) };
      }
      setInfos([...got]);
    });
    setRows((prev) => buildRows(got, prev));
    setReading(false);
  }

  function clearAll() {
    setFiles([]);
    setInfos([]);
    setRows([]);
    setResults({});
    setStarted(false);
  }

  const patch = (key: string, p: Partial<Row>) => setRows((all) => {
    const next = all.map((r) => (r.key === key ? { ...r, ...p } : r));
    if (p.report === undefined) return next;
    // A report now paired with this CAS leaves its own "no CAS" row; one taken off comes back as a lone row.
    const used = new Set(next.flatMap((r) => (r.cas !== null && r.report !== null ? [r.report] : [])));
    const kept = next.filter((r) => r.cas !== null || (r.report !== null && !used.has(r.report)));
    const lone = reports.filter((i) => !used.has(i) && !kept.some((r) => r.cas === null && r.report === i));
    return [...kept, ...lone.map((i) => ({ key: `r${i}`, cas: null, report: i, onlyTwo: false, kind: "AUTO" as Kind, fresh: "", skip: false }))];
  });
  const ready = (r: Row) => r.cas !== null && r.report !== null && !r.skip && !done(results[r.key]) && !infos[r.cas]?.message?.startsWith("This CAS shows no PAN");

  async function onboard(only?: string) {
    setRunning(true);
    setStarted(true);
    const todo = rows.filter((r) => (only ? r.key === only : ready(r)));
    setResults((x) => ({ ...x, ...Object.fromEntries(todo.map((r) => [r.key, { outcome: "QUEUED" as const }])) }));
    for (const r of todo) {
      setResults((x) => ({ ...x, [r.key]: { outcome: "WORKING" } }));
      const fd = new FormData();
      fd.set("cas", files[r.cas!]);
      fd.set("report", files[r.report!]);
      if (advisorId) fd.set("advisor_id", advisorId);
      if (password) fd.set("password", password);
      fd.set("report_kind", r.kind);
      if (r.fresh.trim()) fd.set("fresh_money", r.fresh.replace(/[^\d.]/g, ""));
      let res: Result;
      try {
        await stageLargeFiles(fd);
        res = await onboardBulkPairAction(fd);
      } catch (e) {
        res = { outcome: "FAILED", message: `${transportError(e)} Retry this client.`, problems: [], usedClaude: false, corrections: [] };
      }
      setResults((x) => ({ ...x, [r.key]: res }));
    }
    setRunning(false);
  }

  const reports = infos.flatMap((x, i) => (x?.kind === "REPORT" ? [i] : []));
  const others = infos.flatMap((x, i) => (x && x.kind !== "CAS" && x.kind !== "REPORT" ? [i] : []));
  const readCount = infos.filter(Boolean).length;
  const readyCount = rows.filter(ready).length;
  const waitingForFile = rows.filter((r) => !r.skip && (r.cas === null || r.report === null));
  const res = Object.values(results);
  const tally = {
    drafts: res.filter((r) => r.outcome === "ONBOARDED").length,
    working: res.filter((r) => busy(r)).length,
    needs: res.filter((r) => r.outcome === "NEEDS_REVIEW" || r.outcome === "FAILED").length + (started ? waitingForFile.length : 0),
  };
  const advisorMissing = advisorRequired && !advisorId;
  const lockedCount = infos.filter((x) => x?.kind === "LOCKED").length;

  return (
    <div className="space-y-4">
      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={async (e) => { e.preventDefault(); setOver(false); if (!running) await add(await filesFromDrop(e.dataTransfer)); }}
        className={cn("rounded-xl border-2 border-dashed px-6 text-center transition-colors", rows.length || others.length ? "py-5" : "py-10", over ? "border-brand bg-brand-50" : "border-border bg-white")}
      >
        <div className="text-[15px] font-semibold">Drop CAS and advisory report PDFs here</div>
        <p className="mt-1 text-sm text-muted">One client or many, in any order, or a whole folder. Files are paired by client by themselves.</p>
        <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
          <Button type="button" variant="outline" size="sm" disabled={running} onClick={() => filesInput.current?.click()}>Choose files</Button>
          <Button type="button" variant="outline" size="sm" disabled={running} onClick={() => folderInput.current?.click()}>Choose a folder</Button>
          {files.length ? <button type="button" className="text-xs text-muted hover:underline" disabled={running || reading} onClick={clearAll}>Clear all</button> : null}
        </div>
        <input ref={filesInput} type="file" accept="application/pdf" multiple hidden onChange={(e) => { void add(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
        <input ref={folderInput} type="file" multiple hidden {...({ webkitdirectory: "", directory: "" } as Record<string, string>)} onChange={(e) => { void add(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
        {reading ? <p className="mt-3 text-xs font-medium text-indigo-700">Reading {readCount} of {files.length} file(s)…</p> : null}
      </div>

      {started ? (
        <div className="flex flex-wrap gap-2 text-xs font-medium">
          <span className="rounded-full bg-emerald-50 px-3 py-1 text-emerald-800">{plural(tally.drafts, "draft")} ready</span>
          {tally.working ? <span className="rounded-full bg-indigo-50 px-3 py-1 text-indigo-800">{tally.working} reading</span> : null}
          {tally.needs ? <span className="rounded-full bg-amber-50 px-3 py-1 text-amber-900">{tally.needs} need{tally.needs === 1 ? "s" : ""} you</span> : null}
          <span className="self-center font-normal text-muted">You can leave this page once nothing is reading; drafts wait under <Link className="text-brand hover:underline" href="/clients?plan=draft">Clients → Drafts</Link>.</span>
        </div>
      ) : null}

      {/* One row per client */}
      {rows.length ? (
        <div className="overflow-hidden rounded-xl border border-border bg-surface">
          {!started ? (
            <div className="hidden grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)_28px] gap-3 border-b border-border bg-slate-50 px-4 py-2 text-[10.5px] font-semibold uppercase tracking-wide text-muted md:grid">
              <span>Client (from the files)</span><span>CAS</span><span>Advisory report</span><span>Ready?</span><span />
            </div>
          ) : null}
          <ul className="divide-y divide-border">
            {rows.map((r) => (
              <ClientRow
                key={r.key} r={r} files={files} infos={infos} result={results[r.key]} started={started} running={running}
                reports={reports} open={open === r.key} onToggle={() => setOpen(open === r.key ? null : r.key)}
                onPatch={(p) => patch(r.key, p)} onRetry={() => onboard(r.key)} canRetry={!advisorMissing}
                onAddCas={() => filesInput.current?.click()} unpairedReports={rows.filter((x) => x.cas === null && x.report !== null).length}
              />
            ))}
          </ul>
        </div>
      ) : null}

      {others.length ? (
        <div className="rounded-xl border border-border bg-white px-4 py-3">
          <div className="mb-1 text-xs font-semibold">Files that are not a CAS or a report we could read</div>
          <ul className="space-y-0.5 text-xs text-muted">
            {others.map((i) => <li key={i}><span className="text-ink">{files[i].name}</span> — {infos[i]!.message || "Could not be read."}</li>)}
          </ul>
        </div>
      ) : null}

      {/* Optional settings, folded */}
      <details className="rounded-xl border border-border bg-white" open={advisorRequired || lockedCount > 0}>
        <summary className="cursor-pointer select-none px-4 py-2.5 text-sm">
          <span className="font-medium">More options</span> <span className="text-muted">· only if needed: CAS password{canChooseAdvisor ? ", advisor" : ""}</span>
        </summary>
        <div className="grid gap-4 border-t border-border px-4 py-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">CAS password (if no saved one opens it)</span>
            <div className="flex gap-2">
              <Input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
              {lockedCount ? <Button type="button" variant="outline" size="sm" className="h-9" disabled={reading || !password} onClick={rereadLocked}>Open {lockedCount} locked</Button> : null}
            </div>
            <span className="mt-1 block text-[11px] text-muted">{templateSet ? "The house template, the file name and saved mobiles are tried first." : "The password template is not configured: type the password here."} Used only to open the files; never stored.</span>
          </label>
          {canChooseAdvisor ? (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">Advisor for new clients{advisorRequired ? " *" : ""}</span>
              <Select value={advisorId} onChange={(e) => setAdvisorId(e.target.value)} disabled={running}>
                <option value="">Choose advisor…</option>
                {advisors.map((a) => <option key={a.id} value={a.id}>{a.full_name} ({a.role.toLowerCase()})</option>)}
              </Select>
              <span className="mt-1 block text-[11px] text-muted">The advisor reviews and approves the draft plan.</span>
            </label>
          ) : null}
        </div>
      </details>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => onboard()} disabled={running || reading || readyCount === 0 || advisorMissing} size="lg">
          {running ? "Creating drafts…" : `Read & create ${readyCount ? plural(readyCount, "draft") : "drafts"}`}
        </Button>
        <span className="text-xs text-muted">
          {advisorMissing ? "Choose the advisor under More options first. " : ""}
          {waitingForFile.length ? `${waitingForFile.map((r) => clientName(r, infos) ?? "One client").join(", ")} wait${waitingForFile.length === 1 ? "s" : ""} for a missing file. ` : ""}
          Nothing is approved without you.
          {!aiReady ? " The Claude reader is not set up: reports the built-in reader cannot reconcile are listed as needing you." : ""}
        </span>
      </div>
    </div>
  );
}

function clientName(r: Row, infos: (BulkFileInfo | null)[]): string | null {
  return (r.cas !== null ? infos[r.cas]?.name : null) ?? (r.report !== null ? infos[r.report]?.name ?? infos[r.report]?.fileName : null) ?? null;
}

function Chip({ ok, warn, children }: { ok?: boolean; warn?: boolean; children: React.ReactNode }) {
  return <span className={cn("inline-block rounded-md px-2 py-0.5 text-xs", ok ? "bg-emerald-50 text-emerald-800" : warn ? "bg-amber-50 text-amber-900" : "bg-red-50 text-red-700")}>{children}</span>;
}

function ClientRow({ r, files, infos, result, started, running, reports, open, onToggle, onPatch, onRetry, canRetry, onAddCas, unpairedReports }: {
  r: Row; files: File[]; infos: (BulkFileInfo | null)[]; result: Result | undefined; started: boolean; running: boolean; reports: number[];
  open: boolean; onToggle: () => void; onPatch: (p: Partial<Row>) => void; onRetry: () => void; canRetry: boolean; onAddCas: () => void; unpairedReports: number;
}) {
  const c = r.cas !== null ? infos[r.cas] : null;
  const rep = r.report !== null ? infos[r.report] : null;
  const name = clientName(r, infos) ?? "Unknown investor";
  const newer = Boolean(c?.casDate && rep?.reportDate && c.casDate > rep.reportDate);
  const row = result && "message" in result ? result : null;

  const who = (
    <div className="min-w-0">
      <div className="truncate font-semibold text-ink">{name}</div>
      <div className="truncate text-[11.5px] text-muted">
        {c ? <>PAN {c.panMasked ?? "—"} · {c.existingClient ? `existing ${c.existingClient}` : "new client"}</> : "from the report name"}
      </div>
    </div>
  );

  // Before onboarding: what was found and whether it is ready.
  const readiness = r.skip ? <span className="text-xs text-muted">Skipped</span>
    : !c ? <span className="text-xs text-amber-900">Add their CAS, or onboard as <Link className="text-brand underline" href="/onboard/new">New MF user</Link></span>
    : !rep && unpairedReports ? <span className="text-xs text-amber-900">No report matched by name: <button type="button" className="text-brand underline" onClick={onToggle}>pick its report</button> ({unpairedReports} not paired).</span>
    : !rep ? <span className="text-xs text-amber-900">Add the advisory report. A new CAS for an existing client goes to the <Link className="text-brand underline" href="/reconciliation">CAS inbox</Link>.</span>
    : c.message.startsWith("This CAS shows no PAN") ? <span className="text-xs text-red-700">{c.message}</span>
    : (
      <span className="text-xs">
        <b className="text-emerald-700">Ready</b>
        {newer ? <span className="text-amber-800"> · CAS newer than report: what the client did since becomes questions</span> : null}
        {r.onlyTwo ? <span className="text-muted"> · paired as the only two files</span> : null}
        {r.kind !== "AUTO" ? <span className="text-muted"> · {KIND_LABEL[r.kind]}</span> : null}
      </span>
    );

  // After: the status of this client's draft.
  let status: React.ReactNode = null;
  if (started) {
    if (!result) status = <div className="text-xs text-muted">{r.skip ? "Skipped" : !c ? "No CAS for this report." : !rep ? "No report for this CAS." : "Not started."}</div>;
    else if (result.outcome === "QUEUED") status = <div className="text-xs text-muted">Waiting its turn…</div>;
    else if (result.outcome === "WORKING") status = <div className="text-xs font-medium text-indigo-700"><span className="mr-1 inline-block h-2 w-2 animate-pulse rounded-full bg-indigo-500" />Reading and checking against the CAS… a report Claude reads takes 1–3 min.</div>;
    else if (row) {
      const d = row.draft;
      status = (
        <div className="text-xs">
          <div className={cn(row.outcome === "ONBOARDED" ? "text-ink" : row.outcome === "ALREADY" ? "text-muted" : "text-red-800")}>
            {row.outcome === "ONBOARDED" ? <>{draftLine(d)}{d?.questions ? <b className="text-amber-800"> {plural(d.questions, "question")} to answer.</b> : null}{d?.toCheck ? <span className="text-amber-800"> {plural(d.toCheck, "line")} to check.</span> : null}{row.newerCas ? " The CAS is newer than the report: trades since became questions." : ""}</>
              : row.message}
            {row.usedClaude ? <span className="ml-1 rounded bg-sky-50 px-1 text-[10.5px] font-medium text-sky-800">read by Claude</span> : null}
          </div>
          {row.problems.length || row.corrections.length ? (
            <button type="button" className="mt-0.5 text-brand hover:underline" onClick={onToggle}>{open ? "Hide details" : `Details (${plural(row.problems.length, "point")})`}</button>
          ) : null}
          {open && row ? (
            <div className="mt-1 space-y-1">
              {row.problems.length ? <ol className="list-decimal space-y-0.5 pl-4 text-red-800">{row.problems.map((x, i) => <li key={i}>{x}</li>)}</ol> : null}
              {row.corrections.length ? <ul className="list-disc space-y-0.5 pl-4 text-muted">{row.corrections.map((x, i) => <li key={i}>Claude: {x}</li>)}</ul> : null}
            </div>
          ) : null}
        </div>
      );
    }
  }

  const cta = row?.planId && row.clientId ? (
    <LinkButton size="sm" variant={row.draft?.questions ? "outline" : "default"} href={`/clients/${row.clientId}/plans/${row.planId}${row.draft?.questions ? "#questions" : ""}`}>
      {row.draft?.questions ? `Answer ${plural(row.draft.questions, "question")}` : "Review & approve"}
    </LinkButton>
  ) : row?.clientId ? <LinkButton size="sm" variant="outline" href={`/clients/${row.clientId}`}>Open client</LinkButton>
    : row && !running && c && rep ? <Button size="sm" variant="outline" onClick={onRetry} disabled={!canRetry}>Retry</Button>
    : started && !c && !result ? (
      <span className="flex gap-1.5"><Button size="sm" variant="outline" onClick={onAddCas}>Add CAS</Button><LinkButton size="sm" variant="outline" href="/onboard/new">New MF user</LinkButton></span>
    ) : null;

  const locked = running || Boolean(result && !(result.outcome === "FAILED" || result.outcome === "NEEDS_REVIEW"));

  return (
    <li className={cn("px-4 py-3", r.skip && "opacity-60", result?.outcome === "ONBOARDED" && "border-l-[3px] border-l-emerald-500", (result?.outcome === "FAILED" || result?.outcome === "NEEDS_REVIEW") && "border-l-[3px] border-l-red-500", started && (!c || !rep) && !r.skip && "border-l-[3px] border-l-amber-500")}>
      {started ? (
        <div className="grid items-center gap-3 md:grid-cols-[minmax(0,1.1fr)_minmax(0,2.2fr)_auto]">
          {who}
          {status}
          <div className="flex justify-end">{cta}</div>
        </div>
      ) : (
        <div className="grid items-center gap-3 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)_28px]">
          {who}
          <div>{c ? <Chip ok>CAS {formatDate(c.casDate)} ✓</Chip> : <Chip>CAS missing</Chip>}{c && c.message && !c.message.startsWith("This CAS shows no PAN") ? <div className="mt-0.5 text-[11px] text-sky-800">{c.message}</div> : null}</div>
          <div>
            {rep ? <Chip ok={rep.readerOk} warn={!rep.readerOk}>Report {rep.reportDate ? formatDate(rep.reportDate) : ""} {rep.readerOk ? "✓" : "· Claude reads it"}</Chip> : <Chip>Report missing</Chip>}
          </div>
          <div>{readiness}</div>
          <button type="button" aria-label={`Options for ${name}`} title="Options" className="h-7 w-7 rounded-md text-muted hover:bg-slate-100" onClick={onToggle}>⋯</button>
        </div>
      )}
      {open && !started ? (
        <div className="mt-3 grid gap-3 rounded-lg bg-slate-50 p-3 sm:grid-cols-4">
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-[11px] font-medium text-muted">Report for this CAS</span>
            <Select value={r.report ?? ""} disabled={locked || r.cas === null} onChange={(e) => onPatch({ report: e.target.value === "" ? null : Number(e.target.value), onlyTwo: false })} className="text-xs">
              <option value="">— no report —</option>
              {reports.map((i) => <option key={i} value={i}>{infos[i]!.name ? `${infos[i]!.name} · ` : ""}{files[i].name}</option>)}
            </Select>
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-muted">What is this report?</span>
            <Select value={r.kind} disabled={locked} onChange={(e) => onPatch({ kind: e.target.value as Kind })} className="text-xs">
              {(Object.keys(KIND_LABEL) as Kind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </Select>
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-muted">Fresh money ₹ (if the report omits it)</span>
            <Input value={r.fresh} disabled={locked} inputMode="numeric" placeholder="read from the report" onChange={(e) => onPatch({ fresh: e.target.value })} className="h-9 text-xs" />
          </label>
          <label className="flex items-center gap-2 text-xs sm:col-span-4">
            <input type="checkbox" checked={r.skip} disabled={locked} onChange={(e) => onPatch({ skip: e.target.checked })} /> Skip this client for now
          </label>
        </div>
      ) : null}
    </li>
  );
}
