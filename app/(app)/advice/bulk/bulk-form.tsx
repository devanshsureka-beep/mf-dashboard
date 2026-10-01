"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Badge } from "@/components/ui/badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { FundPicker, type PickedFund } from "@/components/app/fund-picker";
import { BULK_MODES, type BulkMode } from "@/lib/domain/bulk-call";
import { formatINR, formatINRCompact, humanize, toISTDateTimeLocal } from "@/lib/format";
import type { FundOption } from "@/services/fund-search";
import type { BulkLine } from "@/services/bulk-advice";
import { CHANNELS } from "@/types/domain";
import { issueBulkAction, previewBulkAction } from "./actions";

export interface BulkClient { id: string; name: string; code: string; advisor: string | null; risk: string | null; value: number; moneyLeft: number; hasPlan: boolean }

export function BulkCallForm({ clients, searchFunds }: { clients: BulkClient[]; searchFunds: (q: string) => Promise<FundOption[]> }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [action, setAction] = useState<"BUY" | "SELL">("BUY");
  const [fund, setFund] = useState<PickedFund | null>(null);
  const [mode, setMode] = useState<BulkMode>("PCT_MONEY_LEFT");
  const [value, setValue] = useState("");
  const [preview, setPreview] = useState<{ lines: BulkLine[]; error?: string; key: string } | null>(null);
  const [state, formAction, pending] = useActionState(issueBulkAction, null);

  const spec = useMemo(() => ({ clientIds: [...selected], fundRef: fund?.value ?? "", action, mode, value: Number(value) || 0 }), [selected, fund, action, mode, value]);
  const specKey = JSON.stringify(spec);
  const ready = selected.size > 0 && fund && Number(value) > 0;

  useEffect(() => {
    if (!ready) return;
    let live = true;
    const t = setTimeout(async () => {
      const r = await previewBulkAction(JSON.parse(specKey));
      if (live) setPreview({ ...r, key: specKey });
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [specKey, ready]);

  const current = ready && preview?.key === specKey ? preview : null;
  const toIssue = current?.lines.filter((l) => l.amount != null) ?? [];
  const total = toIssue.reduce((s, l) => s + (l.amount ?? 0), 0);
  const allOn = clients.length > 0 && clients.every((c) => selected.has(c.id));
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  if (state?.ok) {
    return (
      <div className="space-y-3 rounded-xl border border-emerald-200 bg-emerald-50/50 p-5">
        <p className="font-medium text-emerald-800">{state.message}</p>
        <ul className="space-y-1 text-sm">
          {state.issued.map((i) => <li key={i.batch}>{i.name} · <span className="num font-medium">{formatINR(i.amount)}</span> · {i.batch} {i.onPlan ? <Badge tone="info">on plan</Badge> : <Badge tone="neutral">off plan</Badge>}</li>)}
        </ul>
        {state.skipped.length ? (
          <div className="text-sm text-muted">Skipped: {state.skipped.map((s) => `${s.name} (${s.reason})`).join("; ")}</div>
        ) : null}
        <div className="flex gap-2">
          <a href="/advice" className="text-sm text-brand hover:underline">Open the call ledger →</a>
          <a href="/advice/bulk" className="text-sm text-brand hover:underline">Another bulk call</a>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_26rem]">
      <div className="overflow-hidden rounded-xl border border-border bg-white">
        <div className="flex items-center justify-between border-b border-border px-4 py-3 text-sm">
          <span><strong>{clients.length}</strong> matching client(s) · <strong>{selected.size}</strong> selected</span>
          <button type="button" className="text-xs text-brand hover:underline" onClick={() => setSelected(allOn ? new Set() : new Set(clients.map((c) => c.id)))}>
            {allOn ? "Clear all" : "Select all"}
          </button>
        </div>
        {clients.length === 0 ? <p className="p-4 text-sm text-muted">No client matches these filters.</p> : (
          <Table className="text-[13px]">
            <THead><TR><TH /><TH>Client</TH><TH>Advisor</TH><TH>Risk</TH><TH className="text-right">Value today</TH><TH className="text-right">Money left</TH><TH className="text-right">This call</TH></TR></THead>
            <TBody>
              {clients.map((c) => {
                const line = current?.lines.find((l) => l.client_id === c.id);
                return (
                  <TR key={c.id} className={selected.has(c.id) ? "bg-brand-50/50" : undefined}>
                    <TD><input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} aria-label={`Select ${c.name}`} /></TD>
                    <TD><div className="font-medium">{c.name}</div><div className="text-[11px] text-muted">{c.code}{c.hasPlan ? "" : " · no plan"}</div></TD>
                    <TD className="text-xs">{c.advisor ?? "—"}</TD>
                    <TD className="text-xs">{humanize(c.risk)}</TD>
                    <TD className="text-right num">{formatINRCompact(c.value)}</TD>
                    <TD className={`text-right num ${c.moneyLeft > 0 ? "font-medium text-amber-700" : "text-muted"}`}>{formatINRCompact(c.moneyLeft)}</TD>
                    <TD className="text-right text-xs">
                      {!selected.has(c.id) ? null : !line ? <span className="text-muted">…</span> : line.amount != null ? (
                        <><span className="num font-medium">{formatINR(line.amount)}</span><div className="text-[11px] text-muted">{line.plan_item_id ? "on plan" : "off plan"}</div></>
                      ) : <span className="text-amber-700">{line.skip}</span>}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </div>

      <form action={formAction} className="h-fit space-y-4 rounded-xl border border-border bg-white p-4 xl:sticky xl:top-4">
        <input type="hidden" name="spec" value={specKey} />
        <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
          {(["BUY", "SELL"] as const).map((a) => (
            <button key={a} type="button" onClick={() => { setAction(a); if (a === "SELL" && mode === "PCT_MONEY_LEFT") setMode("PCT_HOLDING"); }}
              className={`flex-1 rounded-md py-1.5 text-sm font-medium ${action === a ? (a === "BUY" ? "bg-white text-emerald-700 shadow-sm" : "bg-white text-red-700 shadow-sm") : "text-muted"}`}>
              {a === "BUY" ? "Buy" : "Sell"}
            </button>
          ))}
        </div>
        <Field label="Fund *">
          <FundPicker search={searchFunds} value={fund} onChange={setFund} />
        </Field>
        <div className="grid grid-cols-[1fr_8rem] gap-2">
          <Field label="How much">
            <Select value={mode} onChange={(e) => setMode(e.target.value as BulkMode)}>
              {BULK_MODES.filter((m) => action === "SELL" || m.value !== "PCT_HOLDING").map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </Select>
          </Field>
          <Field label={mode === "FIXED" ? "₹ per client" : "%"}>
            <Input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder={mode === "FIXED" ? "200000" : "25"} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Communicated at (IST) *"><Input type="datetime-local" name="communicated_at" defaultValue={toISTDateTimeLocal()} required /></Field>
          <Field label="Channel *">
            <Select name="channel" defaultValue="WHATSAPP">{CHANNELS.map((c) => <option key={c} value={c}>{c.replace("_", " ")}</option>)}</Select>
          </Field>
        </div>
        <Field label="Notes (saved on every call)"><Textarea name="notes" rows={2} placeholder="e.g. Market down 2%: deploy part of the cash" /></Field>

        <div className="rounded-lg bg-slate-50 p-3 text-sm">
          {!ready ? <span className="text-muted">Select clients, a fund and an amount to see each client&apos;s call.</span>
            : current?.error ? <span className="text-red-700">{current.error}</span>
            : !current ? <span className="text-muted">Working out amounts…</span>
            : <>
                <strong>{toIssue.length}</strong> call(s) · total <span className="num font-medium">{formatINR(total)}</span>
                {current.lines.length - toIssue.length ? <span className="text-amber-700"> · {current.lines.length - toIssue.length} skipped</span> : null}
              </>}
        </div>
        <Button type="submit" className="w-full" disabled={pending || !current || toIssue.length === 0}>
          {pending ? "Recording…" : `Record ${toIssue.length || ""} ${action === "BUY" ? "buy" : "sell"} call(s) as issued`}
        </Button>
        {state && !state.ok ? <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{state.error}</p> : null}
      </form>
    </div>
  );
}
