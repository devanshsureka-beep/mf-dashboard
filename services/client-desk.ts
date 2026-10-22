/**
 * Data for the client page: one row per fund (holding + plan line + what was
 * advised / executed on it, with dates) and the tranches (each closed by the
 * CAS taken after it). Amounts come from the metrics views; nothing here
 * recomputes target / advised / executed / pending.
 */
import type { Tx } from "@/lib/db/tx";
import { getPortfolioViews, planLineFor, type PlanLine } from "@/services/portfolio-views";

const num = (v: unknown) => (v == null ? 0 : Number(v));
const normFolio = (f: string | null) => (f ?? "").replace(/[^0-9a-z]/gi, "").toLowerCase();
const holdingKey = (r: { isin: string | null; security_id: string | null; scheme_name: string; folio_number: string | null }) =>
  `${r.isin ?? r.security_id ?? r.scheme_name.toLowerCase()}|${normFolio(r.folio_number)}`;

export type FundEventKind = "PLAN" | "CALL" | "EXECUTED" | "CAS";
export interface FundEvent { date: string; kind: FundEventKind; text: string; href?: string }

export interface FundPlan {
  planItemId: string;
  label: string;
  tone: "sell" | "buy" | "keep" | "other";
  note: string | null;
  target: number;
  advised: number;
  executed: number;
  pending: number;
  remaining: number;
  pct: number | null;
  status: string;
  done: boolean;
}

export interface FundRow {
  key: string;
  securityId: string | null;
  name: string;
  planType: string | null;
  category: string | null;
  folio: string | null;
  isNew: boolean;
  exited: boolean;
  notHeld: boolean;
  value: number | null;
  units: number | null;
  nav: number | null;
  navDate: string | null;
  isLive: boolean;
  onboardingValue: number | null;
  change: number | null;
  plan: FundPlan | null;
  advisedDates: string[];
  executedDates: string[];
  unitsTrail: { date: string; units: number }[];
  events: FundEvent[];
}

export interface FundTotals { value: number; onboarding: number; advised: number; executed: number; pending: number; remaining: number; sellTarget: number; buyTarget: number }

const ADVICE_LABEL: Record<string, string> = { BUY: "Buy", SELL: "Sell", SWITCH: "Switch" };

function planOf(p: PlanLine, liveValue: number | null, sipNote: string | null): FundPlan {
  const full = p.side === "SELL" && p.current_amount != null && p.target_amount >= p.current_amount * 0.99;
  const label =
    p.action === "RETAIN" ? "Keep"
    : p.side === "SELL" ? (full ? `Exit ${fmtL(p.target_amount)}` : `Sell ${fmtL(p.target_amount)}`)
    : p.side === "BUY" ? `Buy ${fmtL(p.target_amount)}`
    : p.action === "MIGRATE" ? "Switch to Direct"
    : p.action.charAt(0) + p.action.slice(1).toLowerCase().replace(/_/g, " ");
  const tone = p.action === "RETAIN" ? "keep" : p.side === "SELL" ? "sell" : p.side === "BUY" ? "buy" : "other";
  const done = p.progress_status === "COMPLETED";
  const pct = p.side !== "NONE" && p.target_amount > 0 ? Math.min(100, Math.round((p.executed_amount / p.target_amount) * 100)) : null;
  const status =
    p.side === "NONE" ? (p.action === "RETAIN" ? "No change advised" : done ? "Done" : "To do")
    : done ? "Done"
    : p.pending_amount > 0.5 ? `${fmtL(p.pending_amount)} waiting for client`
    : p.advised_amount < 0.5 ? "Not advised yet"
    : `${pct}% · rest in a next tranche`;
  const notes = [full ? "full exit" : null, sipNote, full && !done && liveValue != null ? `worth ${fmtL(liveValue)} today` : null].filter(Boolean);
  return {
    planItemId: p.plan_item_id, label, tone, note: notes.length ? notes.join(" · ") : null,
    target: p.target_amount, advised: p.advised_amount, executed: p.executed_amount, pending: p.pending_amount,
    remaining: p.yet_to_advise_amount, pct, status, done,
  };
}

function fmtL(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e7) return `₹${(v / 1e7).toFixed(2).replace(/\.?0+$/, "")}Cr`;
  if (a >= 1e5) return `₹${(v / 1e5).toFixed(2).replace(/\.?0+$/, "")}L`;
  if (a >= 1e3) return `₹${(v / 1e3).toFixed(1).replace(/\.0$/, "")}K`;
  return `₹${Math.round(v)}`;
}

export async function getFundRows(tx: Tx, clientId: string): Promise<{ rows: FundRow[]; totals: FundTotals; casDate: string | null; baselineDate: string | null }> {
  const views = await getPortfolioViews(tx, clientId);
  const meta = new Map(
    (await tx<{ id: string; category: string | null; plan_type: string | null }[]>`
      select sm.id, coalesce(m.category, sm.category) as category, sm.plan_type from public.security_master sm
      left join public.mf_schemes m on m.isin = sm.isin
      where sm.id in (select security_id from public.portfolio_holdings where client_id = ${clientId}
                      union select security_id from public.advisory_plan_items where client_id = ${clientId})`).map((m) => [m.id, m]),
  );
  const plan = await tx<{ approved_at: Date | null; plan_date: string; id: string }[]>`
    select id, approved_at, plan_date::text as plan_date from public.advisory_plans where client_id = ${clientId} and status = 'ACTIVE' limit 1`;
  const planDate = plan[0] ? (plan[0].approved_at ? isoDate(plan[0].approved_at) : plan[0].plan_date) : null;
  const sips = await tx<{ security_id: string; action: string; monthly_amount: number }[]>`
    select si.security_id, si.action, si.new_amount as monthly_amount from public.sip_plan_items si
    join public.advisory_plans p on p.id = si.plan_id and p.status = 'ACTIVE'
    where si.client_id = ${clientId} and si.status <> 'CANCELLED' and si.security_id is not null`;
  const sipNote = (sid: string | null) => {
    const s = sips.find((x) => x.security_id === sid);
    if (!s) return null;
    return s.action === "START" ? `+ SIP ${fmtL(num(s.monthly_amount))}/mo` : s.action === "STOP" ? "stop SIP" : `SIP → ${fmtL(num(s.monthly_amount))}/mo`;
  };

  // Calls and executions on this client's funds.
  const calls = await tx<{ id: string; security_id: string; plan_item_id: string | null; action: string; status: string; amount: number; at: string; folio_number: string | null }[]>`
    select v.id, v.security_id, v.plan_item_id, v.action, v.status, v.effective_advised_amount as amount,
           to_char(v.communicated_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD') as at, v.folio_number
    from public.v_advice_items v where v.client_id = ${clientId} order by v.communicated_at`;
  const execs = await tx<{ advice_item_id: string; security_id: string; date: string; amount: number; units: number | null; verification_type: string }[]>`
    select e.advice_item_id, e.security_id, e.execution_date::text as date, e.executed_amount as amount, e.executed_units as units, e.verification_type
    from public.executions e where e.client_id = ${clientId} and e.status in ('EXECUTED', 'PARTIAL') order by e.execution_date`;
  // Trades seen in CAS since onboarding.
  const txns = views.baseline
    ? await tx<{ security_id: string; date: string; type: string; amount: number | null; units: number | null }[]>`
        select security_id, transaction_date::text as date, public.txn_effective_type(transaction_type, description, units) as type, amount, units
        from public.v_cas_transactions
        where client_id = ${clientId} and security_id is not null and transaction_date > ${views.baseline.snapshot_date}::date
        order by transaction_date`
    : [];
  // Units in every confirmed CAS.
  const trail = await tx<{ security_id: string; folio_number: string | null; date: string; units: number }[]>`
    select h.security_id, h.folio_number, s.snapshot_date::text as date, sum(h.units) as units
    from public.portfolio_holdings h join public.portfolio_snapshots s on s.id = h.snapshot_id
    where h.client_id = ${clientId} and s.review_status = 'CONFIRMED' and not s.is_correction and h.security_id is not null
    group by h.security_id, h.folio_number, s.snapshot_date order by s.snapshot_date`;
  const snapDates = [...new Set((await tx<{ date: string }[]>`
    select snapshot_date::text as date from public.portfolio_snapshots
    where client_id = ${clientId} and review_status = 'CONFIRMED' and not is_correction order by snapshot_date`).map((r) => r.date))];

  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const short = (d: string) => `${d.slice(8, 10)}-${MON[Number(d.slice(5, 7)) - 1]}`;
  const dates = (ds: string[]) => [...new Set(ds)].map(short);

  const build = (base: {
    key: string; securityId: string | null; name: string; planType: string | null; folio: string | null;
    value: number | null; units: number | null; nav: number | null; navDate: string | null; isLive: boolean;
    onboardingValue: number | null; isNew: boolean; exited: boolean; notHeld: boolean;
  }, p: PlanLine | null): FundRow => {
    const sid = base.securityId;
    const lineCalls = p ? calls.filter((c) => c.plan_item_id === p.plan_item_id && num(c.amount) > 0) : [];
    const lineCallIds = new Set(lineCalls.map((c) => c.id));
    const fundCalls = calls.filter((c) => c.security_id === sid);
    const fundCallIds = new Set(fundCalls.map((c) => c.id));
    const events: FundEvent[] = [];
    if (p && planDate) events.push({ date: planDate, kind: "PLAN", text: `Plan: ${planOf(p, null, sipNote(sid)).label.toLowerCase()}${p.reason ? ` · ${p.reason}` : ""}` });
    for (const c of fundCalls) {
      events.push({ date: c.at, kind: "CALL", text: `${ADVICE_LABEL[c.action] ?? c.action} ${fmtL(num(c.amount))} advised${c.status === "REVISED" ? " (revised)" : c.status === "CANCELLED" ? " (cancelled)" : ""}`, href: `/advice/items/${c.id}` });
    }
    for (const e of execs.filter((x) => fundCallIds.has(x.advice_item_id))) {
      events.push({ date: e.date, kind: "EXECUTED", text: `Executed ${fmtL(num(e.amount))}${e.units != null ? ` · ${num(e.units).toLocaleString("en-IN", { maximumFractionDigits: 3 })} u` : ""}${e.verification_type === "CAS_VERIFIED" ? " · verified in CAS" : ""}` });
    }
    const casTx = txns.filter((t) => t.security_id === sid);
    for (const t of casTx.slice(-12)) {
      events.push({ date: t.date, kind: "CAS", text: `In CAS: ${t.type.toLowerCase().replace(/_/g, " ")}${t.amount != null ? ` ${fmtL(Math.abs(num(t.amount)))}` : ""}${t.units != null ? ` · ${Math.abs(num(t.units)).toLocaleString("en-IN", { maximumFractionDigits: 3 })} u` : ""}` });
    }
    if (casTx.length > 12) events.push({ date: casTx[casTx.length - 13].date, kind: "CAS", text: `${casTx.length - 12} earlier CAS transaction(s) not shown` });
    events.sort((a, b) => b.date.localeCompare(a.date));

    const byDate = new Map<string, number>();
    for (const t of trail.filter((x) => x.security_id === sid && (!base.folio || normFolio(x.folio_number) === normFolio(base.folio)))) byDate.set(t.date, (byDate.get(t.date) ?? 0) + num(t.units));
    const unitsTrail = snapDates.map((d) => ({ date: d, units: byDate.get(d) ?? 0 })).filter((u, i, a) => u.units > 0 || (i > 0 && a[i - 1].units > 0));

    const m = sid ? meta.get(sid) : undefined;
    return {
      ...base,
      planType: base.planType ?? m?.plan_type ?? null,
      category: m?.category ?? null,
      change: base.onboardingValue != null && base.value != null ? base.value - base.onboardingValue : base.isNew && base.value != null ? base.value : null,
      plan: p ? planOf(p, base.value, sipNote(sid)) : null,
      advisedDates: dates(lineCalls.map((c) => c.at)),
      executedDates: dates(execs.filter((e) => lineCallIds.has(e.advice_item_id)).map((e) => e.date)),
      unitsTrail,
      events,
    };
  };

  const rows: FundRow[] = [];
  const baseRows = views.baseline?.rows ?? [];
  const baseByKey = new Map(baseRows.map((b) => [holdingKey(b), b]));
  const cur = views.current?.rows ?? [];
  const curKeys = new Set(cur.map(holdingKey));
  const usedPlan = new Set<string>();
  for (const r of cur) {
    const b = baseByKey.get(holdingKey(r));
    const p = planLineFor(views.plan, r);
    if (p) usedPlan.add(p.plan_item_id);
    rows.push(build({
      key: r.holding_id, securityId: r.security_id, name: r.scheme_name, planType: r.plan_type, folio: r.folio_number,
      value: r.live_value, units: r.units, nav: r.nav, navDate: r.nav_date, isLive: r.is_live,
      onboardingValue: b ? b.current_value : views.baseline ? 0 : null, isNew: !!views.baseline && !b, exited: false, notHeld: false,
    }, p));
  }
  for (const b of baseRows.filter((x) => !curKeys.has(holdingKey(x)))) {
    const p = planLineFor(views.plan, b);
    if (p) usedPlan.add(p.plan_item_id);
    rows.push(build({
      key: `exit-${b.id}`, securityId: b.security_id, name: b.scheme_name, planType: b.plan_type, folio: b.folio_number,
      value: 0, units: 0, nav: null, navDate: null, isLive: false, onboardingValue: b.current_value, isNew: false, exited: true, notHeld: false,
    }, p));
  }
  for (const p of views.plan.filter((x) => !usedPlan.has(x.plan_item_id) && x.side !== "NONE")) {
    rows.push(build({
      key: `plan-${p.plan_item_id}`, securityId: p.security_id, name: p.scheme_name, planType: null, folio: p.folio_number,
      value: null, units: null, nav: null, navDate: null, isLive: false, onboardingValue: views.baseline ? 0 : null, isNew: true, exited: false, notHeld: true,
    }, p));
  }
  // Sells and buys first (largest remaining first), then kept funds by value.
  const rank = (r: FundRow) => (r.plan?.tone === "sell" ? 0 : r.plan?.tone === "buy" ? 1 : r.plan?.tone === "other" ? 2 : 3);
  rows.sort((a, b) => rank(a) - rank(b) || (b.plan?.remaining ?? 0) - (a.plan?.remaining ?? 0) || (b.value ?? 0) - (a.value ?? 0));

  // Totals: one plan line can sit on two folios, so count each line once.
  const seen = new Set<string>();
  const totals: FundTotals = { value: 0, onboarding: 0, advised: 0, executed: 0, pending: 0, remaining: 0, sellTarget: 0, buyTarget: 0 };
  for (const r of rows) {
    totals.value += r.value ?? 0;
    totals.onboarding += r.onboardingValue ?? 0;
    if (r.plan && !seen.has(r.plan.planItemId)) {
      seen.add(r.plan.planItemId);
      totals.advised += r.plan.advised; totals.executed += r.plan.executed; totals.pending += r.plan.pending; totals.remaining += r.plan.remaining;
      if (r.plan.tone === "sell") totals.sellTarget += r.plan.target;
      if (r.plan.tone === "buy") totals.buyTarget += r.plan.target;
    }
  }
  return { rows, totals, casDate: views.current?.snapshot_date ?? null, baselineDate: views.baseline?.snapshot_date ?? null };
}

function isoDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

// ───────────────────────────── Tranches ─────────────────────────────

export interface LedgerRow {
  id: string;
  tranche: number;
  advisedOn: string;
  by: string | null;
  action: string;
  fund: string;
  planType: string | null;
  advised: number;
  executed: number;
  executedOn: string | null;
  executedUnits: number | null;
  pending: number;
  status: string;
  casVerified: boolean;
  /** Done by hand (approved), not yet shown by a CAS. */
  approved: number;
}

export interface Tranche {
  number: number; // 0 = onboarding
  from: string | null;
  to: string | null; // the CAS date that closed it
  open: boolean;
  calls: number;
  advisedSell: number;
  advisedBuy: number;
  executedSell: number;
  executedBuy: number;
  pending: number;
  casValue: number | null;
  runId: string | null;
  unadvisedOpen: number;
  unadvisedTotal: number;
  /** SIPs, kept apart from the lump-sum Buy / Sell numbers above. */
  sip: TrancheSip;
}

export interface TrancheSip {
  /** SIP lines advised in this tranche (not yet advised ones sit in the open tranche). */
  lines: number;
  starts: number;
  changes: number;
  stops: number;
  /** ₹/month the advised START / CHANGE lines run at. */
  monthly: number;
  /** Of those lines, how many a CAS already shows done. */
  done: number;
  /** SIP instalments the CAS that closed this tranche shows in its window. */
  instalments: number;
  invested: number;
}

/** One SIP line of the plan, in the tranche it was advised in. */
export interface SipLedgerRow {
  id: string;
  tranche: number;
  advisedOn: string | null;
  action: "START" | "STOP" | "CHANGE";
  fund: string;
  oldAmount: number | null;
  newAmount: number | null;
  status: string;
  completedOn: string | null;
  invested: number;
  instalments: number;
  lastInstalment: string | null;
}

export async function getTranches(tx: Tx, clientId: string): Promise<{ tranches: Tranche[]; ledger: LedgerRow[]; sipLedger: SipLedgerRow[]; baseline: { date: string; value: number } | null }> {
  const snaps = await tx<{ id: string; date: string; value: number; is_baseline: boolean }[]>`
    select id, snapshot_date::text as date, total_current_value as value, is_baseline from public.portfolio_snapshots
    where client_id = ${clientId} and review_status = 'CONFIRMED' and not is_correction order by snapshot_date, created_at`;
  const bIdx = Math.max(0, snaps.findIndex((s) => s.is_baseline));
  const chain = snaps.slice(bIdx); // onboarding CAS, then every later CAS
  const items = await tx<(LedgerRow & { side: string })[]>`
    select v.id, to_char(v.communicated_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD') as "advisedOn", pr.full_name as by,
           v.action, v.scheme_name as fund, sm.plan_type as "planType", v.effective_advised_amount as advised,
           v.executed_amount as executed, v.last_execution_date::text as "executedOn", v.executed_units as "executedUnits",
           v.pending_amount as pending, v.status, coalesce(t.cas_verified, false) as "casVerified", v.unverified_executed_amount as approved,
           case when v.action = 'BUY' then 'BUY' else 'SELL' end as side
    from public.v_advice_items v
    left join public.profiles pr on pr.id = v.advisor_id
    left join public.security_master sm on sm.id = v.security_id
    left join public.v_advice_execution_timing t on t.advice_item_id = v.id
    where v.client_id = ${clientId}
    order by v.communicated_at desc, v.created_at desc`;
  const runs = await tx<{ id: string; current_snapshot_id: string; open: number; total: number }[]>`
    select r.id, r.current_snapshot_id,
           count(m.id) filter (where m.classification = 'UNADVISED' and m.status in ('SUGGESTED', 'UNEXPLAINED') and m.reviewed_at is null)::int as open,
           count(m.id) filter (where m.classification = 'UNADVISED')::int as total
    from public.reconciliation_runs r left join public.reconciliation_matches m on m.run_id = r.id
    where r.client_id = ${clientId} and r.status <> 'CANCELLED'
    group by r.id, r.current_snapshot_id, r.created_at order by r.created_at`;

  // SIP lines of every plan that was approved (drafts and cancelled lines are not advice).
  const sipLines = await tx<(Omit<SipLedgerRow, "tranche"> & { approvedOn: string | null })[]>`
    select s.id, s.action, s.scheme_name as fund, s.old_amount::float8 as "oldAmount", s.new_amount::float8 as "newAmount", s.status,
           to_char(s.advised_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD') as "advisedOn",
           to_char(p.approved_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD') as "approvedOn",
           to_char(s.completed_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD') as "completedOn",
           coalesce(v.invested_amount, 0)::float8 as invested, coalesce(v.instalments, 0)::int as instalments,
           v.last_instalment_date::text as "lastInstalment"
    from public.sip_plan_items s
    -- A merged additional plan's lines live on in the active plan (counted once, there); a replaced
    -- plan's never-advised lines were never advice.
    join public.advisory_plans p on p.id = s.plan_id and p.status in ('ACTIVE', 'COMPLETED', 'REPLACED')
    left join public.v_sip_item_progress v on v.sip_item_id = s.id
    where s.client_id = ${clientId} and s.status <> 'CANCELLED' and (p.status = 'ACTIVE' or s.status <> 'PLANNED')
    order by coalesce(s.advised_at, p.approved_at, s.created_at) desc, s.scheme_name`;
  // SIP instalments the CAS files show (v_sip_instalments: SIP-worded purchases, plain "Purchase" lines
  // repeating every month, less bounced ones; the same rule as the SIP tab and the CAS matching).
  const sipTxns = (await tx<{ date: string; amount: number }[]>`
    select transaction_date::text as date, amount::float8 as amount from public.v_sip_instalments where client_id = ${clientId}`)
    .map((r) => ({ date: r.date, amount: Number(r.amount) }));

  // Tranche n (n ≥ 1) runs from CAS n-1 up to (not including) the date of CAS n.
  const trancheOf = (d: string) => {
    let n = 1;
    for (let i = 1; i < chain.length; i++) if (d >= chain[i].date) n = i + 1;
    return n;
  };
  const ledger: LedgerRow[] = items.map((i) => ({
    ...i, advised: num(i.advised), executed: num(i.executed), pending: num(i.pending), approved: num(i.approved),
    executedUnits: i.executedUnits == null ? null : num(i.executedUnits), tranche: trancheOf(i.advisedOn),
  }));
  const lastClosed = Math.max(0, chain.length - 1);
  // A SIP line belongs to the tranche it was advised in; one not advised yet waits in the open tranche.
  const sipLedger: SipLedgerRow[] = sipLines.map(({ approvedOn, ...l }) => ({
    ...l, tranche: l.advisedOn ? trancheOf(l.advisedOn) : l.status === "PLANNED" ? lastClosed + 1 : trancheOf(approvedOn ?? chain[0]?.date ?? "0000-00-00"),
  }));
  const maxCalled = Math.max(ledger.reduce((m, r) => Math.max(m, r.tranche), 0), sipLedger.reduce((m, r) => Math.max(m, r.tranche), 0));
  const tranches: Tranche[] = [];
  for (let n = 1; n <= Math.max(lastClosed + 1, maxCalled); n++) {
    // A revised call keeps what was executed on it before the revision (its advised amount is that part,
    // per v_advice_items): it counts in the money, not as a call of its own.
    const rows = ledger.filter((r) => r.tranche === n);
    const closing = chain[n];
    const run = closing ? runs.find((r) => r.current_snapshot_id === closing.id) : undefined;
    const sl = sipLedger.filter((r) => r.tranche === n);
    const from = chain[n - 1]?.date ?? null;
    const inst = closing ? sipTxns.filter((t) => (!from || t.date > from) && t.date <= closing.date) : [];
    const sip: TrancheSip = {
      lines: sl.length,
      starts: sl.filter((r) => r.action === "START").length,
      changes: sl.filter((r) => r.action === "CHANGE").length,
      stops: sl.filter((r) => r.action === "STOP").length,
      monthly: sl.filter((r) => r.action !== "STOP").reduce((t, r) => t + (r.newAmount ?? 0), 0),
      done: sl.filter((r) => r.status === "COMPLETED").length,
      instalments: inst.length,
      invested: Math.round(inst.reduce((t, x) => t + num(x.amount), 0) * 100) / 100,
    };
    const sum = (side: string, k: "advised" | "executed") => rows.filter((r) => (r.action === "BUY" ? "BUY" : "SELL") === side).reduce((s, r) => s + r[k], 0);
    tranches.push({
      number: n, from: chain[n - 1]?.date ?? null, to: closing?.date ?? null, open: !closing,
      calls: rows.filter((r) => r.status !== "REVISED").length, advisedSell: sum("SELL", "advised"), advisedBuy: sum("BUY", "advised"),
      executedSell: sum("SELL", "executed"), executedBuy: sum("BUY", "executed"),
      pending: rows.reduce((s, r) => s + r.pending, 0),
      casValue: closing ? num(closing.value) : null, runId: run?.id ?? null, unadvisedOpen: run?.open ?? 0, unadvisedTotal: run?.total ?? 0,
      sip,
    });
  }
  tranches.reverse();
  return { tranches, ledger, sipLedger, baseline: chain[0] ? { date: chain[0].date, value: num(chain[0].value) } : null };
}
