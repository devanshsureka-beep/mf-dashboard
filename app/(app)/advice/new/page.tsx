import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/form";
import { PageHeader } from "@/components/app/page-header";
import { Money } from "@/components/app/money";
import { IssueAdviceForm, type RunningSip } from "@/components/app/issue-advice-form";
import { ADVISORY_ROLES, pageData } from "@/lib/server";
import { getClientSummary, listAdvisors, listClientSummaries } from "@/services/clients";
import { getAdvisablePlanItems } from "@/services/plans";
import { getHoldings } from "@/services/portfolio";
import { getSipStatus, type SipStatusView } from "@/services/sip-status";
import { issueAdviceAction, searchFundsAction } from "../actions";
import type { HoldingRow } from "@/types/domain";

export const metadata = { title: "Issue call" };

export default async function NewAdvicePage(props: PageProps<"/advice/new">) {
  const sp = await props.searchParams;
  const clientId = typeof sp.client === "string" ? sp.client : null;
  const planItem = typeof sp.planItem === "string" ? sp.planItem : null;
  const side = sp.side === "SELL" || sp.side === "BUY" ? sp.side : "ALL";
  // A preselected plan item is shown regardless of the side filter.
  const effectiveSide = typeof sp.planItem === "string" ? "ALL" : side;

  if (!clientId) {
    const { clients } = await pageData(async (tx) => ({ clients: await listClientSummaries(tx) }), ADVISORY_ROLES);
    return (
      <>
        <PageHeader title={`Issue ${side === "ALL" ? "" : side.toLowerCase() + " "}call`} subtitle="Choose the client first." />
        <Card className="max-w-xl">
          <CardContent>
            <form method="get" className="flex gap-2">
              <input type="hidden" name="side" value={side} />
              <Select name="client" required defaultValue="">
                <option value="" disabled>Choose client…</option>
                {clients.map((c) => <option key={c.client_id} value={c.client_id}>{c.full_name} · {c.client_code}{c.active_plan_id ? "" : " (no active plan)"}</option>)}
              </Select>
              <Button type="submit">Continue</Button>
            </form>
          </CardContent>
        </Card>
      </>
    );
  }

  const { c, items, holdings, advisors, sipSeen, actor } = await pageData(async (tx) => {
    const c = await getClientSummary(tx, clientId);
    return {
      c,
      sipSeen: await getSipStatus(tx, clientId),
      items: await getAdvisablePlanItems(tx, clientId),
      holdings: c.latest_snapshot_id ? await getHoldings(tx, c.latest_snapshot_id) : [],
      advisors: await listAdvisors(tx),
    };
  }, ADVISORY_ROLES);

  return (
    <>
      <PageHeader
        title={`Issue ${side === "ALL" ? "" : side.toLowerCase() + " "}call · ${c.full_name}`}
        subtitle={<>Records what you ACTUALLY communicated to the client. Remaining sell to advise <Money value={c.yet_to_advise_sell} /> · buy <Money value={c.yet_to_advise_buy} />.</>}
        actions={
          <div className="flex gap-1 text-xs">
            {(["SELL", "BUY", "ALL"] as const).map((s) => (
              <Link key={s} href={`/advice/new?client=${clientId}&side=${s}`} className={`rounded-md px-2 py-1 ${s === side ? "bg-brand text-white" : "bg-white ring-1 ring-border"}`}>{s}</Link>
            ))}
          </div>
        }
      />
      {!c.active_plan_id ? <p className="mb-3 text-sm text-amber-700">This client has no ACTIVE plan: only off-plan calls are possible.</p> : null}
      <IssueAdviceForm
        key={`${clientId}:${effectiveSide}:${planItem ?? ""}`}
        action={issueAdviceAction.bind(null, clientId)}
        side={effectiveSide}
        preselect={planItem}
        planItems={items.filter((i) => i.side !== "NONE").map((i) => ({
          id: i.plan_item_id, security_id: i.security_id, scheme_name: i.scheme_name, action: i.action, side: i.side as "SELL" | "BUY",
          target_amount: i.target_amount, advised_amount: i.advised_amount, pending_amount: i.pending_amount, yet_to_advise_amount: i.yet_to_advise_amount,
          full_exit_units: fullExitUnits(i, holdings),
        }))}
        holdings={holdings.filter((h) => h.security_id).map((h) => ({ security_id: h.security_id!, scheme_name: h.scheme_name, units: h.units, nav: h.latest_nav, folio: h.folio_number }))}
        searchFunds={searchFundsAction}
        // SIPs the latest CAS shows running: "Full portfolio redemption" offers a Stop SIP line for each.
        runningSips={c.active_plan_id ? runningSips(sipSeen, holdings) : []}
        advisors={actor.role === "ADMIN" ? advisors.filter((a) => a.role === "ADVISOR") : undefined}
      />
    </>
  );
}

/** All units of the holding a not-yet-advised full-exit SELL line covers (its folio when named), else null. */
function fullExitUnits(
  i: { side: string; action: string; security_id: string | null; folio_number: string | null; target_amount: number; current_amount: number | null; advised_amount: number },
  holdings: { security_id: string | null; folio_number: string | null; units: number }[],
): number | null {
  if (i.side !== "SELL" || i.action !== "SELL" || !i.security_id || !i.current_amount || i.advised_amount > 0) return null;
  if (i.target_amount < i.current_amount * 0.999) return null;
  const norm = (f: string | null) => (f ?? "").replace(/[^0-9a-z]/gi, "").toLowerCase();
  const same = holdings.filter((h) => h.security_id === i.security_id);
  const inFolio = i.folio_number ? same.filter((h) => norm(h.folio_number) === norm(i.folio_number)) : same;
  const units = (inFolio.length ? inFolio : same).reduce((t, h) => t + Number(h.units), 0);
  return units > 0 ? Math.round(units * 10000) / 10000 : null;
}

/** One line per fund the latest CAS shows a SIP running in (a fund's folios added together). */
function runningSips(sip: SipStatusView, holdings: HoldingRow[]): RunningSip[] {
  const out = new Map<string, RunningSip>();
  for (const f of sip.funds) {
    if (f.now.state !== "ACTIVE" || !f.now.amount) continue;
    const h = holdings.find((x) => x.security_id && f.isin && x.isin === f.isin);
    if (!h?.security_id) continue;
    const prev = out.get(h.security_id);
    out.set(h.security_id, { security_id: h.security_id, scheme_name: h.scheme_name, amount: (prev?.amount ?? 0) + f.now.amount });
  }
  return [...out.values()];
}
