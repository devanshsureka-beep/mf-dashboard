import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/app/page-header";
import { HubTabs } from "@/components/app/hub-tabs";
import { LinkButton } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import { cn, uuidOrNull } from "@/lib/utils";
import { PAGES } from "@/lib/brand";
import { formatDate, formatINRCompact, humanize } from "@/lib/format";
import { ADVISORY_ROLES, pageData } from "@/lib/server";
import { filterDeskRows, fundAudience, listDeskRows, readyCounts, type DeskFilter, type ReadyList } from "@/services/advise-desk";
import { listAdvisors } from "@/services/clients";
import { RISK_PROFILES, type RiskProfile } from "@/types/domain";
import { AutoForm, FindSearch } from "./find-search";
import { DeskTable, FundTable } from "./find-tables";

export const metadata = { title: "Find clients" };

const LISTS: ReadyList[] = ["cash", "buys", "sells", "quiet", "all"];
const CAPTION: Record<ReadyList, string> = {
  cash: "Cash to invest · most cash first",
  buys: "Plan buys not advised yet · biggest first",
  sells: "Plan sells not advised yet · biggest first",
  quiet: "No tranche in 30+ days · longest first",
  all: "All clients",
};

export default async function FindClientsPage(props: PageProps<"/advice/find">) {
  const sp = await props.searchParams;
  const one = (k: string) => (typeof sp[k] === "string" && sp[k] ? (sp[k] as string) : null);
  const fundId = uuidOrNull(one("fund"));
  const list = (LISTS.includes(one("list") as ReadyList) ? one("list") : "cash") as ReadyList;
  const risk = RISK_PROFILES.includes(one("risk") as RiskProfile) ? (one("risk") as RiskProfile) : null;
  const cashLakh = Number(one("cash_min"));
  const f: DeskFilter = {
    list, risk, advisorId: uuidOrNull(one("advisor")),
    cashMin: cashLakh > 0 ? cashLakh * 100000 : null,
    left: (["buy", "sell", "none"] as const).find((x) => x === one("left")) ?? null,
    last: (["7", "30", "never"] as const).find((x) => x === one("last")) ?? null,
    // Clients with calls still waiting are left out unless asked for.
    hideWaiting: one("waiting") !== "show",
  };

  const { rows, fund, advisors, actor } = await pageData(async (tx) => ({
    rows: fundId ? [] : await listDeskRows(tx, { advisorId: f.advisorId, risk: f.risk }),
    fund: fundId ? await fundAudience(tx, fundId, { advisorId: f.advisorId, risk: f.risk }) : null,
    advisors: await listAdvisors(tx),
  }));
  // Operations do not advise: their part of this section is Waiting.
  if (!ADVISORY_ROLES.includes(actor.role)) redirect("/executions/pending");

  // The tiles count with the same filters as the table (only the list itself differs).
  const counts = readyCounts(filterDeskRows(rows, { ...f, list: "all" }));
  const shown = fundId ? [] : filterDeskRows(rows, f);
  const keep = (patch: Record<string, string | null>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (typeof v === "string" && v && k !== "round") q.set(k, v);
    for (const [k, v] of Object.entries(patch)) if (v == null) q.delete(k); else q.set(k, v);
    const s = q.toString();
    return `/advice/find${s ? `?${s}` : ""}`;
  };
  const tile = (key: ReadyList, label: string, value: string, sub: string, tone: string) => (
    <Link key={key} href={keep({ list: key })} aria-current={list === key ? "true" : undefined}
      className={cn("flex min-h-24 flex-col gap-0.5 rounded-xl border bg-white px-3.5 py-3 hover:border-brand", list === key ? "border-2 border-brand bg-brand-50/50" : "border-border")}>
      <span className="text-[13px] font-semibold">{label}</span>
      <span className={cn("text-[22px] font-bold num", tone)}>{value}</span>
      <span className="text-xs text-muted">{sub}</span>
    </Link>
  );
  const totalCash = rows.reduce((t, r) => t + r.in_bank, 0);
  const totalLeft = rows.reduce((t, r) => t + r.buy_left + r.sell_left, 0);

  return (
    <>
      <PageHeader
        title={PAGES.calls}
        subtitle={fundId ? <Link href="/advice/find" className="text-brand hover:underline">← All clients</Link>
          : <>{rows.length} clients · <b className="text-emerald-700">{formatINRCompact(totalCash)}</b> cash waiting to be invested · <b>{formatINRCompact(totalLeft)}</b> of plans not advised yet</>}
        actions={actor.role !== "OPERATIONS" ? <LinkButton href="/advice/new">Issue call</LinkButton> : null}
      />
      <HubTabs hub="calls" active="find" role={actor.role} />
      {one("round") ? <p className="mb-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">Round finished: {one("round")} client(s) advised. Their calls are now under Waiting; each new CAS marks them done.</p> : null}

      <div className="mb-4 rounded-2xl border border-border bg-white p-3">
        <FindSearch initial={fund?.scheme_name ?? ""} key={fundId ?? "desk"} />
      </div>

      {fundId && !fund ? <p className="rounded-xl border border-border bg-white p-4 text-sm text-muted">That fund was not found.</p> : null}

      {fund ? (
        <>
          <section className="mb-4 flex flex-wrap items-center gap-5 rounded-2xl border border-border bg-white px-5 py-4">
            <div className="min-w-[18rem] flex-1">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Fund{fund.category ? ` · ${humanize(fund.category)}` : ""}{fund.isin ? ` · ${fund.isin}` : ""}</div>
              <h2 className="mt-0.5 text-xl font-semibold">{fund.scheme_name}</h2>
            </div>
            <div className="grid flex-[2] grid-cols-2 gap-4 sm:grid-cols-4">
              {(() => {
                const held = fund.rows.filter((r) => r.holding);
                const plans = fund.rows.filter((r) => r.plan);
                const todo = fund.rows.filter((r) => r.advised === "NOT_ADVISED");
                const sum = (side: string) => todo.filter((r) => r.plan?.side === side).reduce((t, r) => t + (r.plan?.left ?? 0), 0);
                const stat = (label: string, value: React.ReactNode, sub: React.ReactNode) => (
                  <div key={label}><div className="text-xs text-muted">{label}</div><div className="text-lg font-bold">{value}</div><div className="text-xs text-muted">{sub}</div></div>
                );
                return [
                  stat("Held by", `${held.length} client${held.length === 1 ? "" : "s"}`, `${formatINRCompact(held.reduce((t, r) => t + (r.holding?.value ?? 0), 0))} in total`),
                  stat("In plans", `${plans.length} plan${plans.length === 1 ? "" : "s"}`, <><span className="text-blue-700">Buy {plans.filter((r) => r.plan?.side === "BUY").length}</span> · <span className="text-red-700">Sell {plans.filter((r) => r.plan?.side === "SELL").length}</span> · Hold {plans.filter((r) => r.plan?.side === "NONE").length}</>),
                  stat("Not advised yet", <span className="text-amber-700">{todo.length} client{todo.length === 1 ? "" : "s"}</span>, `Buy ${formatINRCompact(sum("BUY"))} · Sell ${formatINRCompact(sum("SELL"))}`),
                  stat("NAV", fund.nav != null ? `₹${fund.nav.toLocaleString("en-IN", { maximumFractionDigits: 4 })}` : "—", fund.nav_date ? formatDate(fund.nav_date) : "no NAV yet"),
                ];
              })()}
            </div>
          </section>
          <FundTable rows={fund.rows} securityId={fund.security_id} />
        </>
      ) : null}

      {!fundId ? (
        <>
          <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted">Ready lists · tap one to fill the table</h2>
          <div className="mb-4 grid grid-cols-2 gap-2.5 md:grid-cols-3 xl:grid-cols-5">
            {tile("cash", "Cash to invest", formatINRCompact(counts.cash.amount), `${counts.cash.clients} clients · sold, not bought back`, "text-emerald-700")}
            {tile("buys", "Plan buys not advised", formatINRCompact(counts.buys.amount), `${counts.buys.clients} clients`, "text-blue-700")}
            {tile("sells", "Plan sells not advised", formatINRCompact(counts.sells.amount), `${counts.sells.clients} clients`, "text-red-700")}
            {tile("quiet", "No tranche in 30+ days", `${counts.quiet.clients} clients`, `${counts.quiet.never} never had one`, "text-ink")}
            {tile("all", "All clients", String(counts.all), "any filter below", "text-ink")}
          </div>

          <AutoForm className="mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-border bg-white px-3.5 py-3">
            <input type="hidden" name="list" value={list} />
            <label className="text-xs text-muted">Cash to invest ≥ (₹ lakh)
              <Input name="cash_min" inputMode="decimal" defaultValue={one("cash_min") ?? ""} placeholder="e.g. 5" className="mt-1 w-32" />
            </label>
            <label className="text-xs text-muted">Plan left to advise
              <Select name="left" defaultValue={f.left ?? ""} className="mt-1 w-40">
                <option value="">Any</option><option value="buy">Buys left</option><option value="sell">Sells left</option><option value="none">Nothing left</option>
              </Select>
            </label>
            <label className="text-xs text-muted">Last tranche
              <Select name="last" defaultValue={f.last ?? ""} className="mt-1 w-44">
                <option value="">Any time</option><option value="7">Over 7 days ago</option><option value="30">Over 30 days ago</option><option value="never">Never</option>
              </Select>
            </label>
            <label className="text-xs text-muted">Risk
              <Select name="risk" defaultValue={risk ?? ""} className="mt-1 w-44">
                <option value="">All</option>
                {RISK_PROFILES.map((r) => <option key={r} value={r}>{humanize(r)}</option>)}
              </Select>
            </label>
            {actor.role === "ADMIN" ? (
              <label className="text-xs text-muted">Advisor
                <Select name="advisor" defaultValue={f.advisorId ?? ""} className="mt-1 w-44">
                  <option value="">All</option>
                  {advisors.filter((a) => a.role === "ADVISOR").map((a) => <option key={a.id} value={a.id}>{a.full_name}</option>)}
                </Select>
              </label>
            ) : null}
            <label className="flex h-10 items-center gap-2 text-[13px]">
              <input type="checkbox" name="waiting" value="show" defaultChecked={!f.hideWaiting} className="h-4 w-4 accent-brand" />
              Include clients with calls still waiting
            </label>
            <span className="flex-1" />
            <Link href={`/advice/find?list=${list}`} className="pb-2.5 text-xs text-muted hover:underline">Reset filters</Link>
          </AutoForm>

          <DeskTable key={JSON.stringify(f)} rows={shown} caption={CAPTION[list]} />
        </>
      ) : null}
    </>
  );
}
