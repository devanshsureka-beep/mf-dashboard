"use client";

import Link from "next/link";
import { useState } from "react";
import { CheckCircle2, AlertTriangle, XCircle } from "lucide-react";
import { Money } from "@/components/app/money";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/form";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { formatDate, humanize } from "@/lib/format";
import { checkDocumentsAction, type CheckResult } from "./actions";

const ICON = {
  PASS: <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" />,
  WARN: <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" />,
  FAIL: <XCircle className="h-5 w-5 shrink-0 text-red-600" />,
};
const ACTION_TONE = { SELL: "danger", SWITCH: "purple", BUY: "success", RETAIN: "muted" } as const;
const SIP_TONE = { START: "success", STOP: "danger", CHANGE: "info" } as const;

export function Checker() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      setResult(await checkDocumentsAction(new FormData(e.currentTarget)));
    } catch {
      setResult({ ok: false, error: "The check could not run (network or file too large). Please try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent>
          <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block text-xs font-medium text-muted">CAS (PDF)</span>
              <Input type="file" name="cas" accept="application/pdf" required disabled={busy} />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-xs font-medium text-muted">Advisory report (PDF)</span>
              <Input type="file" name="report" accept="application/pdf" required disabled={busy} />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-xs font-medium text-muted">Client mobile number (to open a locked CAS)</span>
              <Input name="mobile" inputMode="tel" autoComplete="off" placeholder="98xxxxxxxx" disabled={busy} />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-xs font-medium text-muted">CAS password (only if the mobile number doesn&apos;t open it)</span>
              <Input name="password" type="password" autoComplete="off" disabled={busy} />
            </label>
            <div className="sm:col-span-2">
              <Button type="submit" disabled={busy}>{busy ? "Reading documents…" : "Check documents"}</Button>
              <span className="ml-3 text-xs text-muted">Read-only: nothing is saved, and the files are not stored.</span>
            </div>
          </form>
        </CardContent>
      </Card>

      {result && !result.ok ? (
        <Card className="border-red-200"><CardContent className="text-sm text-red-700">{result.error}</CardContent></Card>
      ) : null}

      {result && result.ok ? <Result r={result} /> : null}
    </div>
  );
}

function Result({ r }: { r: Extract<CheckResult, { ok: true }> }) {
  const fails = r.checks.filter((c) => c.status === "FAIL");
  const warns = r.checks.filter((c) => c.status === "WARN");
  const sells = r.items.filter((i) => i.action === "SELL" || i.action === "SWITCH");
  const buys = r.items.filter((i) => i.action === "BUY");
  const retains = r.items.filter((i) => i.action === "RETAIN");
  return (
    <>
      <div className={`rounded-lg border p-4 ${r.canOnboard ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50"}`}>
        <div className="flex items-start gap-3">
          {r.canOnboard ? ICON.PASS : ICON.FAIL}
          <div className="text-sm">
            <div className={`font-semibold ${r.canOnboard ? "text-emerald-800" : "text-red-800"}`}>
              {r.canOnboard
                ? "Everything reconciles. These documents are safe to onboard."
                : `${fails.reduce((t, c) => t + c.problems.length, 0)} problem(s) found. Onboarding would refuse these documents and save nothing.`}
            </div>
            <div className="mt-0.5 text-ink/80">
              {r.investor.name ?? "—"} · PAN {r.investor.pan ?? "—"} · CAS valued {formatDate(r.cas.valuationDate)} ({humanize(r.cas.source)}) ·{" "}
              {r.cas.funds} funds, <Money value={r.cas.total} full /> · report prepared {formatDate(r.report.prepared)}
            </div>
            <div className="mt-0.5 text-ink/80">
              {r.existingClient
                ? <>Existing client <Link className="text-brand hover:underline" href={`/clients/${r.existingClient.id}`}>{r.existingClient.name} ({r.existingClient.code})</Link>: onboarding would add a new draft plan; approving it replaces the current one.</>
                : "New client: onboarding would create the client from these documents."}
              {warns.length ? " The CAS snapshot will need a manual confirmation (see below)." : ""}
            </div>
            {r.canOnboard ? <Link className="mt-2 inline-block text-sm font-medium text-brand hover:underline" href="/onboard">Go to Onboard Client →</Link> : null}
          </div>
        </div>
      </div>

      <Card>
        <CardHeader><CardTitle>Checks</CardTitle></CardHeader>
        <CardContent className="divide-y divide-border p-0">
          {r.checks.map((c) => (
            <div key={c.id} className="flex gap-3 px-4 py-3">
              {ICON[c.status]}
              <div className="text-sm">
                <div className="font-medium">{c.label}</div>
                {c.detail ? <div className="text-xs text-muted">{c.detail}</div> : null}
                {c.problems.length ? (
                  <ul className={`mt-1 list-disc space-y-0.5 pl-5 text-xs ${c.status === "FAIL" ? "text-red-700" : "text-amber-800"}`}>
                    {c.problems.map((p, i) => <li key={i}>{p}</li>)}
                  </ul>
                ) : null}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {r.items.length ? (
        <Card>
          <CardHeader>
            <CardTitle>Plan that would be created (draft)</CardTitle>
            <span className="text-xs text-muted">
              Sell <Money value={sells.reduce((t, i) => t + i.target_amount, 0)} full /> · Buy <Money value={buys.reduce((t, i) => t + i.target_amount, 0)} full /> · {retains.length} retained
            </span>
          </CardHeader>
          <Table className="text-[13px]">
            <THead><TR><TH>Action</TH><TH>Fund (as in the CAS)</TH><TH>ISIN</TH><TH>Folio</TH><TH className="text-right">Amount</TH><TH className="text-right">CAS value</TH><TH>From the report</TH></TR></THead>
            <TBody>
              {r.items.map((i, k) => (
                <TR key={k}>
                  <TD><Badge tone={ACTION_TONE[i.action]}>{i.action}</Badge></TD>
                  <TD className="max-w-72"><div className="truncate" title={i.scheme_name}>{i.scheme_name}</div></TD>
                  <TD className="num text-xs">{i.isin ?? <span className="text-muted">new fund</span>}</TD>
                  <TD className="num text-xs">{i.folio_number ?? "—"}</TD>
                  <TD className="text-right">{i.action === "RETAIN" ? "—" : <Money value={i.target_amount} full />}</TD>
                  <TD className="text-right"><Money value={i.current_amount} full /></TD>
                  <TD className="max-w-64 text-xs text-muted"><div className="truncate" title={i.reason ?? ""}>{i.reason ?? ""}</div></TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      ) : null}

      {r.sips.length ? (
        <Card>
          <CardHeader><CardTitle>SIP changes that would be created</CardTitle></CardHeader>
          <Table className="text-[13px]">
            <THead><TR><TH>Change</TH><TH>Fund</TH><TH>ISIN</TH><TH className="text-right">Current / month</TH><TH className="text-right">New / month</TH><TH>Note</TH></TR></THead>
            <TBody>
              {r.sips.map((s, k) => (
                <TR key={k}>
                  <TD><Badge tone={SIP_TONE[s.action]}>{s.action}</Badge></TD>
                  <TD className="max-w-72"><div className="truncate" title={s.scheme_name}>{s.scheme_name}</div></TD>
                  <TD className="num text-xs">{s.isin ?? <span className="text-muted">new fund</span>}</TD>
                  <TD className="text-right"><Money value={s.old_amount} full /></TD>
                  <TD className="text-right"><Money value={s.new_amount} full /></TD>
                  <TD className="max-w-64 text-xs text-muted"><div className="truncate" title={s.notes ?? ""}>{s.notes ?? ""}</div></TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      ) : null}
    </>
  );
}
