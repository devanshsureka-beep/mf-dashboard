import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import { PageHeader } from "@/components/app/page-header";
import { HubTabs } from "@/components/app/hub-tabs";
import { PAGES } from "@/lib/brand";
import { ADVISORY_ROLES, pageData } from "@/lib/server";
import { listAdvisors, listClientSummaries } from "@/services/clients";
import { fundsHeldMatching, holdingsOfFund, type HeldFund } from "@/services/bulk-advice";
import { formatINRCompact } from "@/lib/format";
import { RISK_PROFILES } from "@/types/domain";
import { humanize } from "@/lib/format";
import { searchFundsAction } from "../actions";
import { BulkCallForm } from "./bulk-form";
import { BULK_MODES, type BulkMode } from "@/lib/domain/bulk-call";

export const metadata = { title: "One call for many clients" };

const lakh = (v: string | undefined) => (v && Number(v) > 0 ? Number(v) * 100000 : null);

export default async function BulkCallPage(props: PageProps<"/advice/bulk">) {
  const sp = await props.searchParams;
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const f = {
    minValue: one("min_value"), maxValue: one("max_value"),
    advisor: one("advisor"), risk: one("risk"), plan: one("plan"), q: one("q"),
    holds: one("holds")?.trim() || undefined,
    holdsSec: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(one("holds_sec") ?? "") ? one("holds_sec") : undefined,
    // From Find clients: the fund, side and amount rule are set, the clients come as ?ids=.
    fund: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(one("fund") ?? "") ? one("fund") : undefined,
  };
  const side = one("side") === "SELL" ? "SELL" : one("side") === "BUY" ? "BUY" : undefined;
  const mode = BULK_MODES.some((m) => m.value === one("mode")) ? (one("mode") as BulkMode) : undefined;
  const { clients, advisors, actor, heldFunds, fund, holdings } = await pageData(async (tx) => {
    // "Holds fund": the funds matching the text; one fund picked (or the only match) filters the clients.
    const heldFunds: HeldFund[] = f.holds && !f.holdsSec ? await fundsHeldMatching(tx, f.holds) : [];
    const secId = f.holdsSec ?? (heldFunds.length === 1 ? heldFunds[0].security_id : undefined) ?? f.fund;
    const fund = secId
      ? (await tx<{ security_id: string; scheme_name: string; nav: number | null }[]>`
          select sm.id as security_id, sm.scheme_name,
                 (select max(h.nav)::float8 from public.v_holding_live h where h.security_id = sm.id) as nav
          from public.security_master sm where sm.id = ${secId}`)[0] ?? null
      : null;
    return {
      clients: await listClientSummaries(tx, { q: f.q, advisorId: f.advisor || undefined, status: "ACTIVE" }),
      advisors: await listAdvisors(tx),
      heldFunds,
      fund,
      holdings: fund ? await holdingsOfFund(tx, fund.security_id) : null,
    };
  }, ADVISORY_ROLES);

  const minValue = lakh(f.minValue), maxValue = lakh(f.maxValue);
  // "Holds fund" filters the clients; a fund set from Find clients only sets the call.
  const byHolding = Boolean(f.holds || f.holdsSec) && holdings;
  // Clients ticked on the Clients list arrive as ?ids=…: show them whatever the filters say.
  const picked = (one("ids") ?? "").split(",").filter((x) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x));
  // Clients picked on the Clients list skip the other filters, but "Holds fund" still applies.
  const matching = picked.length ? clients.filter((c) => picked.includes(c.client_id) && (!byHolding || holdings!.has(c.client_id))) : clients
    .filter((c) => minValue == null || (c.live_portfolio_value ?? 0) >= minValue)
    .filter((c) => maxValue == null || (c.live_portfolio_value ?? 0) <= maxValue)
    .filter((c) => !f.risk || c.risk_profile === f.risk)
    .filter((c) => !f.plan || (f.plan === "yes" ? Boolean(c.active_plan_id) : !c.active_plan_id))
    .filter((c) => !byHolding || holdings!.has(c.client_id))
    .sort((a, b) => holdings
      ? (holdings.get(b.client_id)?.value ?? 0) - (holdings.get(a.client_id)?.value ?? 0)
      : (b.live_portfolio_value ?? 0) - (a.live_portfolio_value ?? 0));
  const keep = (extra: Record<string, string>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (typeof v === "string" && v && k !== "holds_sec") q.set(k, v);
    for (const [k, v] of Object.entries(extra)) q.set(k, v);
    return `/advice/bulk?${q.toString()}`;
  };

  return (
    <>
      <PageHeader
        title={PAGES.calls}
        subtitle={<>One call for many clients. Each client gets their own call in the ledger, linked to their plan when the plan has this fund. <Link href="/advice/find" className="text-brand hover:underline">← Find clients</Link></>}
      />
      <HubTabs hub="calls" active="find" role={actor.role} />

      {picked.length ? <p className="mb-3 rounded-md bg-brand-50 px-3 py-2 text-sm text-brand-700">{matching.length} client(s) picked. <Link href="/advice/find" className="underline">Pick again on Find clients</Link></p> : null}
      <form method="get" className="mb-4 grid gap-2 rounded-xl border border-border bg-white p-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
        <label className="text-xs text-muted sm:col-span-2">Holds fund (name or ISIN)
          <Input name="holds" defaultValue={f.holds ?? ""} placeholder="e.g. parag flexi, or INF879O01027" />
        </label>
        <label className="text-xs text-muted">Value today ≥ (₹ lakh)<Input name="min_value" inputMode="decimal" defaultValue={f.minValue} /></label>
        <label className="text-xs text-muted">Value today ≤ (₹ lakh)<Input name="max_value" inputMode="decimal" defaultValue={f.maxValue} /></label>
        <label className="text-xs text-muted">Risk profile
          <Select name="risk" defaultValue={f.risk ?? ""}>
            <option value="">Any</option>
            {RISK_PROFILES.map((r) => <option key={r} value={r}>{humanize(r)}</option>)}
          </Select>
        </label>
        {actor.role === "ADMIN" ? (
          <label className="text-xs text-muted">Advisor
            <Select name="advisor" defaultValue={f.advisor ?? ""}>
              <option value="">All</option>
              {advisors.filter((a) => a.role === "ADVISOR").map((a) => <option key={a.id} value={a.id}>{a.full_name}</option>)}
            </Select>
          </label>
        ) : null}
        <label className="text-xs text-muted">Active plan
          <Select name="plan" defaultValue={f.plan ?? ""}>
            <option value="">Any</option><option value="yes">Has a plan</option><option value="no">No plan</option>
          </Select>
        </label>
        <div className="flex items-end gap-2">
          <Button type="submit" variant="outline">Filter</Button>
          <Link href="/advice/bulk" className="pb-2 text-xs text-muted hover:underline">Reset</Link>
        </div>
      </form>

      {f.holds && !fund ? (
        <div className="mb-4 rounded-xl border border-border bg-white">
          <div className="border-b border-border px-4 py-2.5 text-sm font-medium">
            {heldFunds.length ? `${heldFunds.length} fund(s) held by your clients match “${f.holds}”: pick one` : `No client holds a fund matching “${f.holds}” in their latest CAS.`}
          </div>
          <ul className="divide-y divide-border text-sm">
            {heldFunds.map((h) => (
              <li key={h.security_id}>
                <Link href={keep({ holds: f.holds!, holds_sec: h.security_id })} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2.5 hover:bg-slate-50">
                  <span className="font-medium text-brand">{h.scheme_name}{h.isin ? <span className="ml-1.5 text-[11px] font-normal text-muted">{h.isin}</span> : null}</span>
                  <span className="text-xs text-muted">{h.clients} client(s) · {formatINRCompact(h.total)} today</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {fund && byHolding ? (
        <p className="mb-3 rounded-md bg-brand-50 px-3 py-2 text-sm text-brand-700">
          Clients holding <strong>{fund.scheme_name}</strong>: {matching.length} · {formatINRCompact(matching.reduce((t, c) => t + (holdings?.get(c.client_id)?.value ?? 0), 0))} in this fund today. The call below is set to this fund.{" "}
          <Link href={keep({ holds: "" })} className="underline">Clear</Link>
        </p>
      ) : null}

      <BulkCallForm
        key={`${fund?.security_id ?? "any"}-${side ?? ""}-${mode ?? ""}`}
        initialAction={side}
        initialMode={mode}
        initialFund={fund ? { value: `sec:${fund.security_id}`, scheme_name: fund.scheme_name, nav: fund.nav } : null}
        clients={matching.map((c) => ({
          id: c.client_id, name: c.full_name, code: c.client_code, advisor: c.advisor_name, risk: c.risk_profile,
          value: c.live_portfolio_value ?? 0, moneyLeft: c.money_left, hasPlan: Boolean(c.active_plan_id),
          holding: holdings?.get(c.client_id) ?? null,
        }))}
        searchFunds={searchFundsAction}
        initial={picked}
      />
    </>
  );
}
