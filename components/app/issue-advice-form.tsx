"use client";

import { useActionState, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { formatINR, formatINRCompact, toISTDateTimeLocal } from "@/lib/format";
import type { ActionResult } from "@/lib/actions";
import { CHANNELS } from "@/types/domain";

export interface AdvisablePlanItem {
  id: string;
  security_id: string | null;
  scheme_name: string;
  action: string;
  side: "SELL" | "BUY";
  target_amount: number;
  advised_amount: number;
  pending_amount: number;
  yet_to_advise_amount: number;
}
export interface HoldingLite { security_id: string; scheme_name: string; units: number; nav: number | null; folio: string | null }
export interface SecurityLite { id: string; scheme_name: string }

interface PlanRow { include: boolean; basis: "AMOUNT" | "UNITS"; amount: string; units: string; price: string }
interface OffRow { key: number; security_id: string; action: "BUY" | "SELL" | "SWITCH"; basis: "AMOUNT" | "UNITS"; amount: string; units: string; price: string }

type Action = (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;

export function IssueAdviceForm({
  action, planItems, holdings, securities, side, preselect, advisors,
}: {
  action: Action;
  planItems: AdvisablePlanItem[];
  holdings: HoldingLite[];
  securities: SecurityLite[];
  side: "SELL" | "BUY" | "ALL";
  preselect?: string | null;
  advisors?: { id: string; full_name: string }[];
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const navOf = useMemo(() => new Map(holdings.map((h) => [h.security_id, h.nav])), [holdings]);
  const unitsOf = useMemo(() => new Map(holdings.map((h) => [h.security_id, h.units])), [holdings]);
  const visible = planItems.filter((p) => side === "ALL" || p.side === side);

  const [rows, setRows] = useState<Record<string, PlanRow>>(() =>
    Object.fromEntries(
      visible.map((p) => [
        p.id,
        {
          include: p.id === preselect,
          basis: "AMOUNT",
          amount: p.id === preselect && p.yet_to_advise_amount > 0 ? String(Math.round(p.yet_to_advise_amount)) : "",
          units: "",
          price: p.security_id && navOf.get(p.security_id) ? String(navOf.get(p.security_id)) : "",
        },
      ]),
    ),
  );
  const [off, setOff] = useState<OffRow[]>([]);
  const [confirmOver, setConfirmOver] = useState(false);

  const setRow = (id: string, patch: Partial<PlanRow>) => setRows((r) => ({ ...r, [id]: { ...r[id], ...patch, include: patch.include ?? true } }));
  const estimate = (basis: string, amount: string, units: string, price: string) =>
    basis === "UNITS" && !amount && units && price ? Number(units) * Number(price) : Number(amount || 0);

  const items = [
    ...visible
      .filter((p) => rows[p.id]?.include)
      .map((p) => {
        const r = rows[p.id];
        return {
          plan_item_id: p.id,
          security_id: p.security_id,
          action: p.action === "BUY" ? "BUY" : p.action === "SWITCH" ? "SWITCH" : "SELL",
          quantity_basis: r.basis,
          advised_amount: Math.round(estimate(r.basis, r.amount, r.units, r.price) * 100) / 100,
          advised_units: r.basis === "UNITS" ? Number(r.units) || null : null,
          reference_price: r.price ? Number(r.price) : null,
          valid_until: null,
        };
      }),
    ...off.map((o) => ({
      plan_item_id: null,
      security_id: o.security_id || null,
      action: o.action,
      quantity_basis: o.basis,
      advised_amount: Math.round(estimate(o.basis, o.amount, o.units, o.price) * 100) / 100,
      advised_units: o.basis === "UNITS" ? Number(o.units) || null : null,
      reference_price: o.price ? Number(o.price) : null,
      valid_until: null,
    })),
  ];
  const overAdvised = visible.filter((p) => rows[p.id]?.include && estimate(rows[p.id].basis, rows[p.id].amount, rows[p.id].units, rows[p.id].price) > p.yet_to_advise_amount + 1);
  const total = (s: string) => items.filter((i) => (s === "BUY" ? i.action === "BUY" : i.action !== "BUY")).reduce((t, i) => t + (i.advised_amount || 0), 0);

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="items" value={JSON.stringify(items)} />
      <div className="grid gap-3 md:grid-cols-4">
        <Field label="Communicated at (IST) *" hint="Exact time the client was told. Immutable once saved.">
          <Input type="datetime-local" name="communicated_at" defaultValue={toISTDateTimeLocal()} required />
        </Field>
        <Field label="Channel *">
          <Select name="channel" defaultValue="PHONE">{CHANNELS.map((c) => <option key={c} value={c}>{c.replace("_", " ")}</option>)}</Select>
        </Field>
        {advisors?.length ? (
          <Field label="Advisor (admin may record on behalf)">
            <Select name="advisor_id" defaultValue="">{[<option key="me" value="">Me</option>, ...advisors.map((a) => <option key={a.id} value={a.id}>{a.full_name}</option>)]}</Select>
          </Field>
        ) : null}
        <Field label="Notes" className="md:col-span-4"><Textarea name="notes" rows={2} placeholder="What was said, market context…" /></Field>
      </div>

      <div className="rounded-lg border border-border">
        <div className="border-b border-border bg-gray-50 px-3 py-2 text-sm font-medium">From the active plan — remaining to advise</div>
        {visible.length === 0 ? (
          <p className="p-3 text-sm text-muted">No open plan items{side !== "ALL" ? ` on the ${side} side` : ""}. Use an off-plan call below if needed.</p>
        ) : (
          <Table className="text-[13px] [&_td]:px-2 [&_th]:px-2">
            <THead>
              <TR><TH /><TH>Security</TH><TH>Action</TH><TH className="text-right">Target</TH><TH className="text-right">Advised</TH><TH className="text-right">Yet to advise</TH><TH>Basis</TH><TH>Amount ₹</TH><TH>Units</TH><TH>Ref. NAV</TH></TR>
            </THead>
            <TBody>
              {visible.map((p) => {
                const r = rows[p.id];
                const est = estimate(r.basis, r.amount, r.units, r.price);
                return (
                  <TR key={p.id} className={r.include ? "bg-blue-50/40" : undefined}>
                    <TD><input type="checkbox" checked={r.include} onChange={(e) => setRow(p.id, { include: e.target.checked })} aria-label="Include" /></TD>
                    <TD className="max-w-64"><div className="truncate" title={p.scheme_name}>{p.scheme_name}</div>{p.security_id && unitsOf.get(p.security_id) ? <div className="text-[11px] text-muted">holds {unitsOf.get(p.security_id)?.toFixed(3)} units</div> : null}</TD>
                    <TD className="text-xs font-semibold">{p.action}</TD>
                    <TD className="text-right num">{formatINRCompact(p.target_amount)}</TD>
                    <TD className="text-right num text-blue-700">{formatINRCompact(p.advised_amount)}</TD>
                    <TD className="text-right num font-medium">
                      {formatINRCompact(p.yet_to_advise_amount)}
                      {p.yet_to_advise_amount > 0 ? (
                        <button type="button" className="ml-1 text-[11px] text-brand hover:underline" onClick={() => setRow(p.id, { amount: String(Math.round(p.yet_to_advise_amount)), basis: "AMOUNT" })}>fill</button>
                      ) : null}
                    </TD>
                    <TD>
                      <Select className="h-8 w-28 text-xs" value={r.basis} onChange={(e) => setRow(p.id, { basis: e.target.value as "AMOUNT" | "UNITS" })}>
                        <option value="AMOUNT">Amount</option><option value="UNITS">Units</option>
                      </Select>
                    </TD>
                    <TD>
                      <Input className="h-8 w-28 text-xs" inputMode="decimal" value={r.amount} placeholder={r.basis === "UNITS" && est ? `≈${Math.round(est)}` : "0"} onChange={(e) => setRow(p.id, { amount: e.target.value })} />
                      {r.include && est > p.yet_to_advise_amount + 1 ? <div className="text-[10px] text-red-700">exceeds remaining</div> : null}
                    </TD>
                    <TD><Input className="h-8 w-24 text-xs" inputMode="decimal" value={r.units} disabled={r.basis === "AMOUNT"} onChange={(e) => setRow(p.id, { units: e.target.value })} /></TD>
                    <TD><Input className="h-8 w-20 text-xs" inputMode="decimal" value={r.price} onChange={(e) => setRow(p.id, { price: e.target.value })} /></TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </div>

      <div className="rounded-lg border border-border">
        <div className="flex items-center justify-between border-b border-border bg-gray-50 px-3 py-2 text-sm font-medium">
          Off-plan calls
          <Button type="button" size="sm" variant="outline" onClick={() => setOff((o) => [...o, { key: Date.now(), security_id: "", action: side === "BUY" ? "BUY" : "SELL", basis: "AMOUNT", amount: "", units: "", price: "" }])}>+ Add off-plan call</Button>
        </div>
        {off.length === 0 ? <p className="p-3 text-xs text-muted">Only for calls outside the approved plan. They are tracked, but not counted against plan targets.</p> : (
          <div className="space-y-2 p-3">
            {off.map((o, idx) => {
              const upd = (patch: Partial<OffRow>) => setOff((all) => all.map((x, i) => (i === idx ? { ...x, ...patch } : x)));
              return (
                <div key={o.key} className="flex flex-wrap items-center gap-2">
                  <Select className="h-8 w-96 text-xs" value={o.security_id} onChange={(e) => upd({ security_id: e.target.value, price: navOf.get(e.target.value) ? String(navOf.get(e.target.value)) : o.price })}>
                    <option value="">Choose security…</option>
                    {securities.map((s) => <option key={s.id} value={s.id}>{s.scheme_name}</option>)}
                  </Select>
                  <Select className="h-8 w-24 text-xs" value={o.action} onChange={(e) => upd({ action: e.target.value as OffRow["action"] })}><option>SELL</option><option>BUY</option><option>SWITCH</option></Select>
                  <Select className="h-8 w-28 text-xs" value={o.basis} onChange={(e) => upd({ basis: e.target.value as OffRow["basis"] })}><option value="AMOUNT">Amount</option><option value="UNITS">Units</option></Select>
                  <Input className="h-8 w-28 text-xs" placeholder="Amount ₹" value={o.amount} onChange={(e) => upd({ amount: e.target.value })} />
                  <Input className="h-8 w-24 text-xs" placeholder="Units" value={o.units} disabled={o.basis === "AMOUNT"} onChange={(e) => upd({ units: e.target.value })} />
                  <Input className="h-8 w-20 text-xs" placeholder="NAV" value={o.price} onChange={(e) => upd({ price: e.target.value })} />
                  <Button type="button" size="sm" variant="ghost" onClick={() => setOff((all) => all.filter((_, i) => i !== idx))}>Remove</Button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-white p-3 ring-1 ring-border">
        <div className="text-sm">
          <strong>{items.length}</strong> call(s) · Sell <span className="num text-red-700">{formatINR(total("SELL"))}</span> · Buy <span className="num text-emerald-700">{formatINR(total("BUY"))}</span>
        </div>
        <div className="flex items-center gap-3">
          {overAdvised.length ? (
            <label className="flex items-center gap-1.5 text-xs text-red-700">
              <input type="checkbox" checked={confirmOver} onChange={(e) => setConfirmOver(e.target.checked)} /> I intend to advise more than the remaining plan amount
            </label>
          ) : null}
          <Button type="submit" disabled={pending || items.length === 0 || (overAdvised.length > 0 && !confirmOver)}>
            {pending ? "Recording…" : "Record calls as issued"}
          </Button>
        </div>
      </div>
      {state && !state.ok ? <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{state.error}</p> : null}
    </form>
  );
}
