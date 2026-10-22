import Link from "next/link";
import { EmptyState } from "@/components/app/page-header";
import { withUserTx, type Actor } from "@/lib/db/tx";
import { formatDate, formatINRCompact, humanize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { getTranches, type LedgerRow, type Tranche } from "@/services/client-desk";
import type { ClientSummary } from "@/types/domain";
import { CasTab } from "./cas";
import { PlanTab } from "./plan";
import { SipTab } from "./sip";

const L = (v: number) => formatINRCompact(v);
const CLOSED = ["REVISED", "CANCELLED", "EXPIRED"];
type View = "waiting" | "done" | "all";

/** Onboarding → each tranche → the next one, in one row. */
function TrancheStrip({ tranches, c, baseline, canAdvise, waitingCount }: { tranches: Tranche[]; c: ClientSummary; baseline: { date: string; value: number } | null; canAdvise: boolean; waitingCount: number }) {
  const remaining = c.yet_to_advise_sell + c.yet_to_advise_buy;
  const ordered = [...tranches].sort((a, b) => a.number - b.number);
  const last = ordered.at(-1);
  const nextNumber = (last?.number ?? 0) + 1;
  const cell = "flex min-w-0 flex-col gap-1 rounded-lg px-3.5 py-3";
  return (
    <section className="grid gap-3 rounded-xl border border-border bg-surface p-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
      <div className={cn(cell, "bg-slate-50")}>
        <div className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-emerald-600" aria-hidden /><b>Onboarding</b><span className="text-xs text-muted">{formatDate(c.onboarding_date)}</span></div>
        <div className="text-[13px] text-slate-600">{baseline ? `Plan from the report · CAS of ${formatDate(baseline.date)} · ${L(baseline.value)}` : "No onboarding CAS"}</div>
      </div>
      {ordered.map((t) => (
        <div key={t.number} className={cn(cell, t.open ? "flex-row items-center justify-between gap-2 bg-orange-50 ring-1 ring-orange-200" : "bg-slate-50")}>
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className={cn("h-2.5 w-2.5 rounded-full", t.open ? "bg-amber-500" : "bg-emerald-600")} aria-hidden />
              <b>Tranche {t.number}</b>
              <span className={cn("text-xs", t.open ? "text-orange-800" : "text-emerald-800")}>{t.open ? "in progress" : `closed by CAS ${formatDate(t.to)}`}</span>
            </div>
            <div className="text-[13px] text-slate-600">
              {t.calls} call(s) · <b className="text-emerald-700">{L(t.executedSell + t.executedBuy)} done</b>
              {t.pending > 0.5 ? <> · <b className="text-amber-700">{L(t.pending)} waiting</b></> : null}
              {t.open && remaining > 0.5 ? <> · <b className="text-brand">{L(remaining)} left to advise</b></> : null}
              {t.runId ? <> · <Link href={`/reconciliation/${t.runId}`} className="text-brand hover:underline">CAS match</Link></> : null}
            </div>
          </div>
          {t.open && canAdvise && (waitingCount > 0 || remaining > 0.5) ? (
            <span className="flex shrink-0 flex-wrap items-center gap-2">
              {/* Opens its own page: approve many waiting calls and SIPs at once. */}
              {waitingCount > 0 ? <Link href={`/clients/${c.client_id}/waiting`} className="rounded-md bg-emerald-700 px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-emerald-800">Approve waiting · {waitingCount}</Link> : null}
              {remaining > 0.5 ? <Link href={`/advice/new?client=${c.client_id}`} className="rounded-md bg-brand px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-brand-700">Advise</Link> : null}
            </span>
          ) : null}
        </div>
      ))}
      {/* New calls go into the open tranche; a "next" card only when every tranche is closed. */}
      {remaining > 0.5 && !last?.open ? (
        <div className={cn(cell, "flex-row items-center justify-between gap-2 border border-dashed border-brand-300")}>
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full border-2 border-brand" aria-hidden /><b>Tranche {nextNumber}</b><span className="text-xs text-brand">next</span></div>
            <div className="text-[13px] text-slate-600">{L(remaining)} to advise</div>
          </div>
          {canAdvise ? <Link href={`/advice/new?client=${c.client_id}`} className="shrink-0 rounded-md bg-brand px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-brand-700">Advise</Link> : null}
        </div>
      ) : null}
    </section>
  );
}

/** Status in desk words, then what the CAS says: done comes from the CAS. */
function StatusCell({ r }: { r: LedgerRow }) {
  if (CLOSED.includes(r.status)) return <span className="text-muted">{humanize(r.status)}</span>;
  const done = r.status === "EXECUTED";
  const part = r.executed > 0.5 && !done;
  // Approved by hand and not in a CAS yet: counted in the money, the next CAS confirms it.
  const approved = r.approved > 0.5;
  const label = done ? (approved ? "Approved" : "Done") : part ? "Part done" : "Waiting";
  const check = r.executed > 0.5 ? (approved ? "waiting for CAS" : r.casVerified ? `CAS verified${r.executedOn ? ` ${formatDate(r.executedOn)}` : ""}` : "recorded by hand") : "not in CAS yet";
  return (
    <span className="whitespace-nowrap">
      <span className={cn("rounded px-2 py-0.5 text-xs font-semibold", approved ? "bg-blue-50 text-blue-800" : done || part ? "bg-emerald-50 text-emerald-800" : "bg-orange-100 text-orange-800")}>{label}</span>
      <span className="ml-1.5 text-xs text-muted">{check}</span>
    </span>
  );
}

function Ledger({ rows, total }: { rows: LedgerRow[]; total: string | null }) {
  if (!rows.length) return <div className="p-4"><EmptyState title="No calls here" /></div>;
  const sum = (k: "advised" | "executed" | "pending") => rows.reduce((t, r) => t + r[k], 0);
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
            <tr key={r.id} className={cn("text-right align-top", CLOSED.includes(r.status) && "text-muted")}>
              <td className="whitespace-nowrap px-4 py-2 text-left text-muted">Tranche {r.tranche}</td>
              <td className="whitespace-nowrap px-2 py-2 text-left">{formatDate(r.advisedOn)}<div className="text-[11px] text-muted">{r.by ?? ""}</div></td>
              <td className="px-2 py-2 text-left">
                <span className={cn("mr-1.5 text-[11px] font-bold", r.action === "BUY" ? "text-blue-700" : "text-red-700")}>{r.action === "BUY" ? "BUY" : r.action === "SELL" ? "SELL" : humanize(r.action).toUpperCase()}</span>
                <Link href={`/advice/items/${r.id}`} className="font-medium hover:underline">{r.fund}</Link>
                {r.planType ? <span className={cn("ml-1.5 rounded px-1.5 py-px text-[10px] font-semibold", r.planType === "REGULAR" ? "bg-amber-50 text-amber-800" : "bg-emerald-50 text-emerald-800")}>{r.planType === "REGULAR" ? "Regular" : "Direct"}</span> : null}
              </td>
              <td className="px-2 py-2 num">{L(r.advised)}</td>
              <td className="px-2 py-2 text-emerald-700 num">{r.executed > 0.5 ? L(r.executed) : <span className="text-slate-400">—</span>}</td>
              <td className="px-2 py-2 font-semibold text-amber-700 num">{r.pending > 0.5 ? L(r.pending) : <span className="font-normal text-slate-400">—</span>}</td>
              <td className="py-2 pl-4 pr-4 text-left"><StatusCell r={r} /></td>
            </tr>
          ))}
        </tbody>
        {total ? (
          <tfoot className="bg-slate-50 text-right font-semibold">
            <tr>
              <td className="px-4 py-2 text-left" colSpan={3}>{total}</td>
              <td className="px-2 py-2 num">{L(sum("advised"))}</td>
              <td className="px-2 py-2 text-emerald-700 num">{L(sum("executed"))}</td>
              <td className="px-2 py-2 text-amber-700 num">{L(sum("pending"))}</td>
              <td />
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}

/** Tranches & SIPs: where each tranche stands, the lump-sum calls (open ones first) and the plan's SIPs. */
export async function TranchesTab({ client: c, actor, view }: { client: ClientSummary; actor: Actor; view: string | null }) {
  const { tranches, ledger, sipLedger, baseline } = await withUserTx(actor, (tx) => getTranches(tx, c.client_id));
  const canAdvise = actor.role !== "OPERATIONS";
  const live = ledger.filter((r) => !CLOSED.includes(r.status));
  const closed = ledger.filter((r) => CLOSED.includes(r.status));
  const waiting = live.filter((r) => r.pending > 0.5);
  const done = live.filter((r) => r.pending <= 0.5);
  const v: View = view === "waiting" || view === "done" || view === "all" ? view : waiting.length ? "waiting" : "all";
  const rows = v === "waiting" ? waiting : v === "done" ? done : live;
  const chip = (k: View, label: string, n: number) => (
    <Link key={k} href={`/clients/${c.client_id}?tab=tranches&view=${k}#ledger`} scroll={false}
      className={cn("rounded-full px-2.5 py-1 ring-1", v === k ? "bg-ink text-white ring-ink" : "bg-white ring-border hover:bg-slate-50")}>{label} {n}</Link>
  );
  return (
    <div className="space-y-3">
      <TrancheStrip tranches={tranches} c={c} baseline={baseline} canAdvise={canAdvise} waitingCount={waiting.length + sipLedger.filter((s) => s.status === "ADVISED").length} />

      <section id="ledger" className="scroll-mt-14 overflow-hidden rounded-xl border border-border bg-surface">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
          <h3 className="text-sm font-semibold">Lump-sum calls · Buy &amp; Sell</h3>
          <div className="flex flex-wrap gap-1.5 text-xs">{chip("waiting", "Waiting", waiting.length)}{chip("done", "Done", done.length)}{chip("all", "All", live.length)}</div>
        </div>
        <Ledger rows={rows} total={v === "waiting" && rows.length ? `${rows.length} call(s) waiting` : null} />
      </section>

      <SipTab client={c} actor={actor} embedded />

      {closed.length ? (
        <details className="rounded-xl border border-border bg-surface">
          <summary className="cursor-pointer select-none px-4 py-2.5 text-sm"><b>Closed calls</b> <span className="text-muted">· {closed.length} cancelled / revised / expired</span></summary>
          <div className="border-t border-border"><Ledger rows={closed} total={null} /></div>
        </details>
      ) : null}

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
