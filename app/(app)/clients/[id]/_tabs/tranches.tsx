import Link from "next/link";
import { EmptyState } from "@/components/app/page-header";
import { withUserTx, type Actor } from "@/lib/db/tx";
import { formatDate, formatINRCompact, formatUnits, humanize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { getTranches, type LedgerRow, type Tranche } from "@/services/client-desk";
import type { ClientSummary } from "@/types/domain";
import { CasTab } from "./cas";
import { PlanTab } from "./plan";

const L = (v: number) => formatINRCompact(v);
/** Call status in desk words: done comes from the CAS. */
const STATUS: Record<string, string> = { ISSUED: "Waiting", PARTIALLY_EXECUTED: "Part done", EXECUTED: "Done" };
const sides = (sell: number, buy: number) => (sell < 0.5 && buy < 0.5 ? "₹0" : [sell >= 0.5 ? `Sell ${L(sell)}` : null, buy >= 0.5 ? `Buy ${L(buy)}` : null].filter(Boolean).join(" · "));

function Box({ label, children, tone }: { label: string; children: React.ReactNode; tone?: string }) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">{label}</div>
      <div className={cn("text-[13px] font-semibold num", tone)}>{children}</div>
    </div>
  );
}

function TrancheCard({ t, c, clientId, canAdvise, sipLeft }: { t: Tranche; c: ClientSummary; clientId: string; canAdvise: boolean; sipLeft: number }) {
  const remaining = c.yet_to_advise_sell + c.yet_to_advise_buy;
  return (
    <article className="rounded-xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className={cn("h-2.5 w-2.5 rounded-full", t.open ? "bg-amber-500" : "bg-emerald-500")} aria-hidden />
          <h3 className="text-[15px] font-semibold">Tranche {t.number}</h3>
          <span className="text-xs text-muted">
            {t.from ? `from CAS ${formatDate(t.from)}` : "before the first CAS"}{t.to ? ` → CAS ${formatDate(t.to)}` : " · in progress"}
          </span>
        </div>
        {t.open ? (
          <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-900">
            {t.pending > 0.5 ? `${L(t.pending)} waiting for client` : remaining > 0.5 ? `Remaining to advise · ${L(remaining)}` : "Waiting for the next CAS"}
          </span>
        ) : (
          <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-800">Closed by CAS {formatDate(t.to)}</span>
        )}
      </div>
      <div className="mt-2.5 grid grid-cols-2 gap-2 md:grid-cols-4">
        <Box label={`Advised · ${t.calls} call(s)`} tone="text-blue-700">{sides(t.advisedSell, t.advisedBuy)}</Box>
        <Box label="Done (from CAS)" tone="text-emerald-700">{sides(t.executedSell, t.executedBuy)}</Box>
        <Box label="CAS after tranche">{t.to ? `${formatDate(t.to)} · ${L(t.casValue ?? 0)}` : "Awaited"}</Box>
        <Box label="Unadvised Trades" tone={t.unadvisedOpen ? "text-red-700" : undefined}>
          {t.to ? (t.unadvisedOpen ? `${t.unadvisedOpen} to review` : t.unadvisedTotal ? `${t.unadvisedTotal} reviewed` : "None") : "—"}
        </Box>
      </div>
      {t.open ? (
        <p className="mt-2.5 text-[12.5px] text-slate-700">
          Left from the plan: Sell {L(c.yet_to_advise_sell)} · Buy {L(c.yet_to_advise_buy)}{sipLeft > 0.5 ? ` · SIPs ${L(sipLeft)}/mo` : ""}.{" "}
          Next: issue the calls → the client acts → upload their new CAS. That CAS marks what was done and closes Tranche {t.number}{remaining > 0.5 ? ` and opens Tranche ${t.number + 1}` : ""}.
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-3 text-xs">
        {t.open && canAdvise && remaining > 0.5 ? <Link href={`/advice/new?client=${clientId}`} className="font-medium text-brand hover:underline">Issue tranche {t.number} calls</Link> : null}
        {t.open ? <Link href={`/clients/${clientId}/cas/upload`} className="font-medium text-brand hover:underline">Upload CAS</Link> : null}
        {t.runId ? <Link href={`/reconciliation/${t.runId}`} className="font-medium text-brand hover:underline">Open the CAS match</Link> : null}
        <a href="#ledger" className="font-medium text-brand hover:underline">See the calls</a>
      </div>
    </article>
  );
}

function Ledger({ rows }: { rows: LedgerRow[] }) {
  if (!rows.length) return <div className="p-4"><EmptyState title="No calls issued yet" /></div>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[980px] text-[13px]">
        <thead className="bg-slate-50 text-right text-[10.5px] font-semibold uppercase tracking-wide text-muted">
          <tr>
            <th className="px-4 py-2 text-left">Tranche</th><th className="px-2 py-2 text-left">Advised on</th><th className="px-2 py-2 text-left">Call</th>
            <th className="px-2 py-2">Advised</th><th className="px-2 py-2">Done</th><th className="px-2 py-2">Waiting</th><th className="py-2 pl-4 pr-4 text-left">Status · CAS check</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr key={r.id} className={cn("text-right align-top", ["REVISED", "CANCELLED", "EXPIRED"].includes(r.status) && "text-muted")}>
              <td className="whitespace-nowrap px-4 py-2 text-left text-muted">Tranche {r.tranche}</td>
              <td className="whitespace-nowrap px-2 py-2 text-left">{formatDate(r.advisedOn)}<div className="text-[11px] text-muted">{r.by ?? ""}</div></td>
              <td className="px-2 py-2 text-left">
                <span className={cn("mr-1.5 rounded-full px-2 py-px text-[11px] font-semibold", r.action === "BUY" ? "bg-blue-50 text-blue-800" : "bg-red-50 text-red-800")}>{humanize(r.action)}</span>
                <Link href={`/advice/items/${r.id}`} className="font-medium hover:underline">{r.fund}</Link>
                {r.planType ? <span className={cn("ml-1.5 rounded px-1.5 py-px text-[10px] font-semibold", r.planType === "REGULAR" ? "bg-amber-50 text-amber-800" : "bg-emerald-50 text-emerald-800")}>{r.planType === "REGULAR" ? "Regular" : "Direct"}</span> : null}
              </td>
              <td className="px-2 py-2 font-semibold text-blue-700 num">{L(r.advised)}</td>
              <td className="px-2 py-2">
                <div className="font-semibold text-emerald-700 num">{r.executed > 0.5 ? L(r.executed) : "—"}</div>
                {r.executedOn ? <div className="whitespace-nowrap text-[11px] text-muted">{formatDate(r.executedOn)}{r.executedUnits ? ` · ${formatUnits(r.executedUnits)} u` : ""}</div> : null}
              </td>
              <td className="px-2 py-2 text-amber-700 num">{r.pending > 0.5 ? L(r.pending) : "—"}</td>
              <td className="py-2 pl-4 pr-4 text-left text-xs">
                {STATUS[r.status] ?? humanize(r.status)}
                {r.casVerified ? <span className="ml-1.5 text-emerald-700">· seen in CAS ✓</span> : r.executed > 0.5 ? <span className="ml-1.5 text-muted">· recorded by hand</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export async function TranchesTab({ client: c, actor, sipLeft, side }: { client: ClientSummary; actor: Actor; sipLeft: number; side: string | null }) {
  const { tranches, ledger, baseline } = await withUserTx(actor, (tx) => getTranches(tx, c.client_id));
  const canAdvise = actor.role !== "OPERATIONS";
  const rows = ledger.filter((r) => !side || (side === "PENDING" ? r.pending > 0.5 : side === "BUY" ? r.action === "BUY" : r.action !== "BUY"));
  const chip = (v: string | null, label: string) => (
    <Link key={label} href={`/clients/${c.client_id}?tab=tranches${v ? `&side=${v}` : ""}#ledger`} scroll={false}
      className={cn("rounded-full px-2.5 py-1 ring-1", side === v ? "bg-ink text-white ring-ink" : "bg-white ring-border hover:bg-slate-50")}>{label}</Link>
  );
  return (
    <div className="space-y-3">
      <p className="rounded-lg bg-brand-50 px-3 py-2 text-xs text-brand-700">Each tranche: calls advised → the client acts → their next CAS shows what was done, and Done fills in by itself. Nothing to record by hand. Unclear matches go to the CAS inbox for one click to confirm.</p>
      {tranches.map((t) => <TrancheCard key={t.number} t={t} c={c} clientId={c.client_id} canAdvise={canAdvise} sipLeft={sipLeft} />)}
      <article className="rounded-xl border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <span className="h-2.5 w-2.5 rounded-full bg-indigo-500" aria-hidden />
            <h3 className="text-[15px] font-semibold">Onboarding</h3>
            <span className="text-xs text-muted">{baseline ? `CAS ${formatDate(baseline.date)}` : "no onboarding CAS"}</span>
          </div>
          <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-semibold text-indigo-800">Starting point</span>
        </div>
        <div className="mt-2.5 grid grid-cols-2 gap-2 md:grid-cols-3">
          <Box label="Plan">{c.active_plan_id ? `Sell ${L(c.target_sell)} · Buy ${L(c.target_buy)}` : "No active plan"}</Box>
          <Box label="Portfolio at onboarding">{baseline ? L(baseline.value) : "—"}</Box>
          <Box label="Onboarded">{formatDate(c.onboarding_date)}</Box>
        </div>
      </article>

      <section id="ledger" className="scroll-mt-14 overflow-hidden rounded-xl border border-border bg-surface">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
          <h3 className="text-sm font-semibold">All calls · {ledger.length}</h3>
          <div className="flex flex-wrap gap-1.5 text-xs">
            {chip(null, "All")}{chip("SELL", "Sell")}{chip("BUY", "Buy")}{chip("PENDING", "Waiting only")}
          </div>
        </div>
        <Ledger rows={rows} />
      </section>

      <details className="rounded-xl border border-border bg-surface">
        <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-semibold">CAS statements, matching runs and plans</summary>
        <div className="space-y-4 border-t border-border p-3">
          <CasTab clientId={c.client_id} actor={actor} />
          <PlanTab clientId={c.client_id} actor={actor} />
        </div>
      </details>
    </div>
  );
}
