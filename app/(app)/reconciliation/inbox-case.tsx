import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { Money } from "@/components/app/money";
import { Input, Select } from "@/components/ui/form";
import { formatDate, formatDateTime, formatINRCompact, formatUnits, humanize } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { InboxCheck, InboxCheckDetail, InboxReading, InboxRunDetail } from "@/services/cas-inbox";
import type { ClientSummary } from "@/types/domain";
import { CHANNELS } from "@/types/domain";
import { confirmCasInInboxAction, confirmMatchFromInboxAction, decideTradeAction, rejectCasInInboxAction } from "./actions";
import { approvedNotInCasAction } from "../clients/[id]/waiting/actions";
import type { ApprovedVsCas } from "@/services/waiting-approve";
import { ActiveDot } from "@/components/app/active-dot";

/** Every open item of one client, from the inbox lists. */
export interface ClientCard {
  client_id: string;
  client_name: string;
  client_code: string;
  snapshot_date: string | null;
  reading: InboxReading[];
  check: InboxCheck[];
  runIds: string[];
  /** Approved trades the latest CAS does not show (asked once). */
  approvedMissing: number;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Why a client is in the inbox, as coloured tags: yellow to review, red blocked, indigo still reading. */
export function reasons(c: ClientCard, details: Record<string, InboxRunDetail>, checks: Record<string, InboxCheckDetail | null>): { label: string; tone: "review" | "blocked" | "reading" }[] {
  const ds = c.runIds.map((id) => details[id]).filter(Boolean);
  const suggested = ds.reduce((n, d) => n + d.suggested.length, 0);
  const trades = ds.reduce((n, d) => n + d.unadvised.length, 0);
  const out: { label: string; tone: "review" | "blocked" | "reading" }[] = [];
  if (c.reading.some((r) => r.status === "FAILED")) out.push({ label: "Couldn't read the PDF", tone: "blocked" });
  else if (c.reading.length) out.push({ label: "Reading…", tone: "reading" });
  for (const x of c.check) { const n = pointsOf(x, checks); out.push({ label: n ? `CAS to check · ${plural(n, "point")}` : "CAS to check", tone: "review" }); }
  if (c.approvedMissing && !c.check.length) out.push({ label: `Approved, not in CAS · ${c.approvedMissing}`, tone: "review" });
  if (suggested) out.push({ label: `${plural(suggested, "call")} to confirm`, tone: "review" });
  if (trades) out.push({ label: `${plural(trades, "trade")}: ours or theirs?`, tone: "review" });
  return out;
}

/** Points shown for a CAS: the explained ones (several reader warnings about one fund are one point). */
const pointsOf = (x: InboxCheck, checks: Record<string, InboxCheckDetail | null>) => checks[x.snapshot_id]?.points.length ?? x.warnings;

export const TONE = {
  review: "bg-amber-50 text-amber-900 ring-1 ring-amber-200",
  blocked: "bg-red-50 text-red-800 ring-1 ring-red-200",
  reading: "bg-indigo-50 text-indigo-800 ring-1 ring-indigo-200",
} as const;

const Step = ({ n, title, tone, children }: { n: number; title: string; tone?: "review" | "done"; children: React.ReactNode }) => (
  <section className={cn("rounded-xl p-4", tone === "review" ? "bg-amber-50 ring-1 ring-amber-300" : tone === "done" ? "bg-emerald-50/60 ring-1 ring-emerald-200" : "ring-1 ring-border")}>
    <h3 className={cn("mb-2 text-[11px] font-bold uppercase tracking-[0.06em]", tone === "review" ? "text-amber-900" : tone === "done" ? "text-emerald-800" : "text-muted")}>{n} · {title}</h3>
    {children}
  </section>
);

function CheckStep({ n, x, d }: { n: number; x: InboxCheck; d: InboxCheckDetail | null }) {
  const points = d?.points ?? [];
  const blocked = points.some((p) => p.severity === "blocked");
  return (
    <Step n={n} title={points.length ? `Needs review: the CAS of ${formatDate(x.snapshot_date)}` : `Check the CAS of ${formatDate(x.snapshot_date)}`} tone="review">
      <p className="text-sm text-slate-700">
        We read {plural(x.funds, "fund")}, {formatINRCompact(x.value)}
        {d?.previous ? <> (last CAS {formatDate(d.previous.date)}: {formatINRCompact(d.previous.value)})</> : d && !d.has_baseline ? <> · first CAS for this client, it becomes the starting portfolio</> : null}.
        {d && d.cost == null ? <span className="text-muted"> · cost not printed in this CAS</span> : null}
      </p>
      {points.length ? (
        <ul className="mt-3 space-y-2">
          {points.map((p, i) => (
            <li key={i} className={cn("rounded-lg bg-white p-3 text-sm ring-1", p.severity === "blocked" ? "ring-red-300" : "ring-amber-300")}>
              <div className={cn("font-semibold", p.severity === "blocked" ? "text-red-800" : "text-amber-900")}>{p.title}</div>
              <div className="mt-0.5 text-slate-700">{p.detail}</div>
            </li>
          ))}
        </ul>
      ) : <p className="mt-2 text-sm text-slate-700">The reader flagged nothing. Glance at the funds against the PDF and confirm.</p>}

      {d?.holdings.length ? (
        <details className="mt-3 rounded-lg bg-white ring-1 ring-amber-200">
          <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-slate-700">All {plural(d.holdings.length, "fund")} we read ▾</summary>
          <table className="w-full border-t border-amber-100 text-xs">
            <thead><tr className="text-left text-muted"><th className="px-3 py-1.5 font-medium">Fund</th><th className="px-3 py-1.5 font-medium">Folio</th><th className="px-3 py-1.5 text-right font-medium">Units</th><th className="px-3 py-1.5 text-right font-medium">Value</th></tr></thead>
            <tbody>
              {d.holdings.map((h, i) => {
                const flagged = points.some((p) => p.kind === "FUND_MATCH" && p.scheme === h.scheme_name && (!p.folio || !h.folio_number || p.folio === h.folio_number));
                return (
                  <tr key={i} className={cn("border-t border-slate-100", flagged && "bg-amber-50")}>
                    <td className="px-3 py-1.5">{h.scheme_name}{flagged ? <b className="ml-1 text-amber-800">· check</b> : null}</td>
                    <td className="px-3 py-1.5 text-muted">{h.folio_number ?? "—"}</td>
                    <td className="num px-3 py-1.5 text-right">{formatUnits(h.units)}</td>
                    <td className="px-3 py-1.5 text-right"><Money value={h.current_value} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </details>
      ) : null}

      <div className="mt-3 flex flex-wrap items-start gap-2">
        <ActionForm action={confirmCasInInboxAction.bind(null, x.snapshot_id)} className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-slate-700"><input type="checkbox" name="confirm" value="yes" required /> I compared {points.length ? "these points" : "the funds"} with the PDF</label>
          <Input name="note" placeholder="Note (optional)" aria-label="Review note" className="h-8 w-44 text-xs" />
          <SubmitButton variant="success" size="sm" confirm={blocked ? "Some points may mean the wrong CAS or wrong numbers. Confirm anyway?" : undefined}>Confirm CAS</SubmitButton>
        </ActionForm>
        {d?.document_id ? <a className="self-center text-xs font-medium text-brand hover:underline" href={`/api/documents/${d.document_id}/download`} target="_blank" rel="noreferrer">Open PDF</a> : null}
        <details className="relative ml-auto">
          <summary className="cursor-pointer list-none rounded-md border border-border bg-white px-3 py-1.5 text-xs font-medium hover:bg-slate-50 [&::-webkit-details-marker]:hidden">Wrong CAS ▾</summary>
          <ActionForm action={rejectCasInInboxAction.bind(null, x.snapshot_id)} className="absolute right-0 z-30 mt-1 w-72 space-y-2 rounded-lg border border-border bg-white p-3 text-xs shadow-lg">
            <p className="text-muted">The CAS stays in history but never counts.</p>
            <Input name="reason" required placeholder="What is wrong? (required)" className="h-8 text-xs" />
            <SubmitButton size="sm" variant="outline">Reject this CAS</SubmitButton>
          </ActionForm>
        </details>
      </div>
    </Step>
  );
}

export function InboxCase({ c, act, details, checks, summary, inBank, approved, next, canAdvise }: {
  c: ClientCard;
  act?: { is_active: boolean; first_advised_at: string | null };
  details: Record<string, InboxRunDetail>;
  checks: Record<string, InboxCheckDetail | null>;
  summary: ClientSummary | null;
  /** Money sold and not bought back (v_client_bank, as on every other screen). */
  inBank: number;
  /** Trades approved by hand, dated on or before this CAS: what the CAS did with each. */
  approved: ApprovedVsCas[];
  next: ClientCard | null;
  canAdvise: boolean;
}) {
  const ds = c.runIds.map((id) => details[id]).filter((d): d is InboxRunDetail => Boolean(d));
  const suggested = ds.flatMap((d) => d.suggested.map((m) => ({ ...m, run_id: d.run_id })));
  const trades = ds.flatMap((d) => d.unadvised.map((m) => ({ ...m, run_id: d.run_id })));
  const done = ds.flatMap((d) => d.done);
  const sipTicked = ds.reduce((n, d) => n + d.sip_lines_ticked, 0);
  const shown = trades.slice(0, 8);
  const tags = reasons(c, details, checks);
  const missing = approved.filter((a) => a.result === "NOT_IN_CAS");
  const open = c.check.reduce((t, x) => t + Math.max(1, pointsOf(x, checks)), 0) + suggested.length + trades.length + missing.length;
  let n = 0;
  const left = summary ? summary.yet_to_advise_sell + summary.yet_to_advise_buy : 0;

  return (
    <div className="rounded-xl border border-border bg-surface">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-5 py-3.5">
        <Link href={`/clients/${c.client_id}`} className="text-lg font-semibold hover:underline"><ActiveDot active={act?.is_active} since={act?.first_advised_at} />{c.client_name}</Link>
        {open ? <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", TONE.review)}>Needs review · {plural(open, "point")}</span> : null}
        <span className="text-xs text-muted">{c.client_code}{c.snapshot_date ? ` · CAS ${formatDate(c.snapshot_date)}` : ""}</span>
        <Link href={`/clients/${c.client_id}`} className="ml-auto text-xs font-medium text-brand hover:underline">Open client →</Link>
      </div>

      <div className="space-y-3 p-4">
        {c.reading.map((r) => (
          <Step key={r.cas_id} n={++n} title={r.status === "FAILED" ? "The PDF could not be read" : "Reading the PDF"}>
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className={r.status === "FAILED" ? "text-red-700" : "text-indigo-700"}>
                {r.status === "FAILED" ? (r.error ?? "Unknown error") : `${humanize(r.status)}… uploaded ${formatDateTime(r.uploaded_at)}`}
              </span>
              <Link className="text-xs font-medium text-brand hover:underline" href={`/cas/${r.cas_id}`}>{r.status === "FAILED" ? "Type the password / retry →" : "Open"}</Link>
            </div>
          </Step>
        ))}

        {c.check.map((x) => <CheckStep key={x.snapshot_id} n={++n} x={x} d={checks[x.snapshot_id] ?? null} />)}

        {suggested.length || trades.length || done.length || sipTicked ? (
          <Step n={++n} title="What this CAS shows against your calls" tone={suggested.length || trades.length ? undefined : "done"}>
            <ul className="space-y-1.5 text-[13px]">
              {done.map((d, i) => (
                <li key={`d${i}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-emerald-50 px-3 py-2">
                  <span><span className="mr-1.5 text-emerald-700">✓</span><b>{d.scheme_name}</b> {d.action === "SELL" ? "sell" : d.action === "BUY" ? "buy" : ""}</span>
                  <span className="text-xs text-emerald-800">your call · done</span>
                </li>
              ))}
              {sipTicked ? <li className="rounded-lg bg-violet-50 px-3 py-2 text-violet-900"><span className="mr-1.5">✓</span>{plural(sipTicked, "SIP line")} ticked from this CAS</li> : null}
              {suggested.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-50 px-3 py-2 ring-1 ring-amber-300">
                  <span><b>{m.scheme_name}</b> {m.action === "SELL" ? "redeemed" : "bought"} <Money value={m.amount} />{m.date ? ` on ${formatDate(m.date)}` : ""}: <b className="text-amber-900">looks like our {m.action?.toLowerCase() ?? ""} call</b></span>
                  <span className="flex items-center gap-2">
                    <ActionForm action={confirmMatchFromInboxAction.bind(null, m.id)}><SubmitButton size="sm" variant="success">Confirm done</SubmitButton></ActionForm>
                    <Link href={`/reconciliation/${m.run_id}`} className="text-xs text-brand hover:underline">Part done / not it →</Link>
                  </span>
                </li>
              ))}
              {shown.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-50 px-3 py-2 ring-1 ring-amber-300">
                  <span><b>{m.scheme_name}</b> {m.change_type === "DECREASE" || m.change_type === "EXITED" ? "redeemed" : "invested"} <Money value={m.amount} />{m.date ? ` on ${formatDate(m.date)}` : ""} · <b className="text-amber-900">no call matches it</b></span>
                  <span className="flex items-center gap-1.5">
                    {canAdvise && m.single_trade ? (
                      <details className="relative">
                        <summary className="cursor-pointer list-none rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium hover:bg-slate-50 [&::-webkit-details-marker]:hidden">Our call ▾</summary>
                        <ActionForm action={decideTradeAction.bind(null, m.id)} className="absolute right-0 z-30 mt-1 w-72 space-y-2 rounded-lg border border-border bg-white p-3 text-xs shadow-lg">
                          <input type="hidden" name="decision" value="ADVISED" />
                          <p className="text-muted">Records the call given outside the dashboard and this trade as its execution.</p>
                          <label className="block">How the client was told *
                            <Select name="channel" required defaultValue="" className="mt-1 h-8 text-xs">
                              <option value="" disabled>Choose…</option>
                              {CHANNELS.map((ch) => <option key={ch} value={ch}>{humanize(ch)}</option>)}
                            </Select>
                          </label>
                          <label className="block">When (empty: the trade day, 09:00)
                            <Input name="communicated_at" type="datetime-local" className="mt-1 h-8 text-xs" />
                          </label>
                          <SubmitButton size="sm" confirm="Record this trade as our call, done?">Record call</SubmitButton>
                        </ActionForm>
                      </details>
                    ) : null}
                    <ActionForm action={decideTradeAction.bind(null, m.id)}><input type="hidden" name="decision" value="OWN" /><SubmitButton size="sm" variant="outline" confirm="Mark this as the client's own trade (no call)?">Client&rsquo;s own</SubmitButton></ActionForm>
                  </span>
                </li>
              ))}
              {trades.length > shown.length ? <li className="px-1 text-xs text-muted">+ {trades.length - shown.length} more trade(s) in the full match table.</li> : null}
            </ul>
            {c.runIds.length ? <div className="mt-2 text-xs">{c.runIds.map((id) => <Link key={id} href={`/reconciliation/${id}`} className="mr-3 text-brand hover:underline">Full match table →</Link>)}<span className="text-muted">units, NAV and part-done decisions</span></div> : null}
          </Step>
        ) : null}

        {approved.length && c.snapshot_date ? (
          <Step n={++n} title="Approved vs this CAS" tone={missing.length ? undefined : "done"}>
            <p className="mb-1.5 text-xs text-muted">Calls a person approved as done before this CAS came. The CAS wins on amounts; only what it cannot settle is asked.</p>
            <ul className="space-y-1.5 text-[13px]">
              {approved.map((a) => (
                <li key={a.execution_id} className={cn("flex flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2",
                  a.result === "VERIFIED" ? "bg-emerald-50" : a.result === "TO_CONFIRM" ? "bg-slate-50" : "bg-red-50 ring-1 ring-red-200")}>
                  <span>
                    <b className={a.action === "BUY" ? "text-blue-700" : "text-red-700"}>{a.action === "BUY" ? "BUY" : "SELL"}</b> <b>{a.scheme_name}</b>
                    {" · "}approved <Money value={a.amount} />{a.units ? ` (${formatUnits(a.units)} u)` : ""} on {formatDate(a.date)}
                    {a.result === "VERIFIED" && a.cas_amount != null ? <> · CAS <Money value={a.cas_amount} /></> : null}
                  </span>
                  {a.result === "VERIFIED" ? <span className="text-xs font-semibold text-emerald-800">✓ Matches · CAS verified</span>
                    : a.result === "TO_CONFIRM" ? <span className="text-xs text-muted">in the matches above: one click</span>
                    : (
                      <span className="flex items-center gap-1.5">
                        <span className="text-xs font-semibold text-red-700">Not in this CAS</span>
                        {canAdvise ? (
                          <>
                            <ActionForm action={approvedNotInCasAction.bind(null, c.client_id, a.execution_id, c.snapshot_date!)}><input type="hidden" name="decision" value="KEEP" /><SubmitButton size="sm" variant="outline">Keep waiting</SubmitButton></ActionForm>
                            <ActionForm action={approvedNotInCasAction.bind(null, c.client_id, a.execution_id, c.snapshot_date!)}><input type="hidden" name="decision" value="UNDO" /><SubmitButton size="sm" variant="outline" confirm="Undo this approval? The call goes back to waiting.">Undo approval</SubmitButton></ActionForm>
                          </>
                        ) : null}
                      </span>
                    )}
                </li>
              ))}
            </ul>
          </Step>
        ) : null}

        {summary?.active_plan_id ? (
          <Step n={++n} title="The plan right now">
            <div className="grid gap-2 text-sm sm:grid-cols-3">
              <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-muted">Left to advise</div><div className="text-base font-semibold text-brand-700"><Money value={left} /></div></div>
              <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-muted">Waiting on client</div><div className={cn("text-base font-semibold", summary.pending_total >= 0.5 && "text-amber-700")}><Money value={summary.pending_total} /></div></div>
              <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-muted">In bank</div><div className="text-base font-semibold"><Money value={inBank} /></div></div>
            </div>
            {c.check.length ? <p className="mt-2 text-xs text-muted">These change once the CAS above is confirmed.</p> : null}
          </Step>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-b-xl border-t border-border bg-slate-50 px-5 py-3">
        {tags.length ? <span className="flex flex-wrap gap-1.5">{tags.map((t, i) => <span key={i} className={cn("rounded-full px-2.5 py-0.5 text-xs font-medium", TONE[t.tone])}>{t.label}</span>)}</span> : null}
        <span className="flex-1" />
        {next ? <Link href={`/reconciliation?c=${next.client_id}`} className="rounded-md bg-ink px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800">Next: {next.client_name} →</Link> : <span className="text-xs text-muted">Last client in the inbox</span>}
      </div>
    </div>
  );
}
