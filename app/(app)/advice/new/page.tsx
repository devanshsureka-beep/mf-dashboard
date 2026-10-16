import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/form";
import { PageHeader } from "@/components/app/page-header";
import { Money } from "@/components/app/money";
import { IssueAdviceForm, type QueueStep, type RunningSip } from "@/components/app/issue-advice-form";
import { ADVISORY_ROLES, pageData } from "@/lib/server";
import { getClientSummary, listAdvisors, listClientSummaries } from "@/services/clients";
import { getAdvisablePlanItems } from "@/services/plans";
import { getHoldings } from "@/services/portfolio";
import { getSipStatus, type SipStatusView } from "@/services/sip-status";
import { issueAdviceAction, searchFundsAction } from "../actions";
import { CHANNELS, type HoldingRow } from "@/types/domain";
import { uuidOrNull } from "@/lib/utils";

export const metadata = { title: "Issue call" };

export default async function NewAdvicePage(props: PageProps<"/advice/new">) {
  const sp = await props.searchParams;
  const clientId = uuidOrNull(sp.client);
  const planItem = uuidOrNull(sp.planItem);
  const side = sp.side === "SELL" || sp.side === "BUY" ? sp.side : "ALL";
  // A preselected plan item is shown regardless of the side filter.
  const effectiveSide = typeof sp.planItem === "string" ? "ALL" : side;
  // A round from Find clients: ?queue= the clients still to come, ?done= how many are behind.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // Each client once, and never the one on screen.
  const queueIds = typeof sp.queue === "string"
    ? [...new Set(sp.queue.split(",").map((x) => x.toLowerCase()))].filter((x) => UUID.test(x) && x !== clientId?.toLowerCase()).slice(0, 300)
    : [];
  const inRound = typeof sp.queue === "string" || typeof sp.done === "string";
  const done = Math.max(0, Math.floor(Number(sp.done) || 0));
  const skipped = Math.max(0, Math.floor(Number(sp.skipped) || 0));
  const at = typeof sp.at === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(sp.at) ? sp.at : undefined;
  const ch = typeof sp.ch === "string" && (CHANNELS as readonly string[]).includes(sp.ch) ? sp.ch : undefined;
  /** This page again for another client of the round (or another side), keeping the round's settings. */
  const roundHref = (client: string, rest: string[], patch: Record<string, string> = {}) => {
    const q = new URLSearchParams({ client });
    if (inRound) {
      q.set("done", String(done));
      if (skipped) q.set("skipped", String(skipped));
      if (rest.length) q.set("queue", rest.join(","));
      if (at) q.set("at", at);
      if (ch) q.set("ch", ch);
    }
    for (const [k, v] of Object.entries(patch)) q.set(k, v);
    return `/advice/new?${q.toString()}`;
  };

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

  const { c, items, holdings, advisors, sipSeen, actor, cash, roundNames } = await pageData(async (tx) => {
    const c = await getClientSummary(tx, clientId);
    return {
      c,
      cash: Number((await tx<{ in_bank: number }[]>`select in_bank::float8 as in_bank from public.v_client_bank where client_id = ${clientId}`)[0]?.in_bank ?? 0),
      roundNames: queueIds.length
        ? await tx<{ client_id: string; full_name: string }[]>`select client_id, full_name from public.v_client_summary where client_id = any(${queueIds}::uuid[])`
        : [],
      sipSeen: await getSipStatus(tx, clientId),
      items: await getAdvisablePlanItems(tx, clientId),
      holdings: c.latest_snapshot_id ? await getHoldings(tx, c.latest_snapshot_id) : [],
      advisors: await listAdvisors(tx),
    };
  }, ADVISORY_ROLES);

  const nameOf = (id: string) => roundNames.find((r) => r.client_id === id)?.full_name ?? "next client";
  const skip = () => (queueIds.length
    ? roundHref(queueIds[0], queueIds.slice(1), { skipped: String(skipped + 1) })
    : `/advice/find?round=${done}`);
  const queue: QueueStep | undefined = inRound
    ? { next: queueIds, done, skipped, nextName: queueIds.length ? nameOf(queueIds[0]) : null, skipHref: skip(), at, channel: ch }
    : undefined;

  return (
    <>
      {queue ? (
        <ol aria-label="Clients in this round" className="mb-4 flex flex-wrap gap-2 text-[13px]">
          {done || skipped ? <li className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-800">✓ {done} done{skipped ? ` · ${skipped} skipped` : ""}</li> : null}
          <li className="rounded-lg border-2 border-brand bg-white px-3 py-1.5"><b>{c.full_name}</b> <span className="text-brand">· now ({done + skipped + 1} of {done + skipped + 1 + queueIds.length})</span></li>
          {queueIds.slice(0, 5).map((id, i) => <li key={id} className="rounded-lg border border-border bg-white px-3 py-2 text-slate-700">{i === 0 ? "Next: " : ""}{nameOf(id)}</li>)}
          {queueIds.length > 5 ? <li className="px-2 py-2 text-muted">+{queueIds.length - 5} more</li> : null}
        </ol>
      ) : null}
      <PageHeader
        title={`Issue ${side === "ALL" ? "" : side.toLowerCase() + " "}call · ${c.full_name}`}
        subtitle={<>Records what you ACTUALLY communicated to the client. Remaining sell to advise <Money value={c.yet_to_advise_sell} /> · buy <Money value={c.yet_to_advise_buy} />.</>}
        actions={
          <div className="flex gap-1 text-xs">
            {(["SELL", "BUY", "ALL"] as const).map((s) => (
              <Link key={s} href={roundHref(clientId, queueIds, { side: s })} className={`rounded-md px-2 py-1 ${s === side ? "bg-brand text-white" : "bg-white ring-1 ring-border"}`}>{s}</Link>
            ))}
          </div>
        }
      />
      {!c.active_plan_id ? <p className="mb-3 text-sm text-amber-700">This client has no ACTIVE plan: only off-plan calls are possible.</p> : null}
      <IssueAdviceForm
        key={`${clientId}:${effectiveSide}:${planItem ?? ""}:${done}`}
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
        queue={queue}
        cash={cash}
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
