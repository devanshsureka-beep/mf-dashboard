import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button, LinkButton } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import { AdviceTable } from "@/components/app/advice-table";
import { EmptyState, PageHeader } from "@/components/app/page-header";
import { Money } from "@/components/app/money";
import { todayIST } from "@/lib/format";
import { pageData } from "@/lib/server";
import { listAdviceLedger, type LedgerFilters } from "@/services/advice";
import { listAdvisors, listClientSummaries } from "@/services/clients";

export const metadata = { title: "Advice call ledger" };

export default async function AdviceLedgerPage(props: PageProps<"/advice">) {
  const sp = await props.searchParams;
  const one = (k: string) => (typeof sp[k] === "string" && sp[k] ? (sp[k] as string) : null);
  const f: LedgerFilters = {
    from: one("from"), to: one("to"), advisorId: one("advisor"), clientId: one("client"),
    side: (one("side") as LedgerFilters["side"]) ?? null, status: (one("status") as LedgerFilters["status"]) ?? null,
  };
  const { rows, advisors, clients, actor } = await pageData(async (tx) => ({
    rows: await listAdviceLedger(tx, f),
    advisors: await listAdvisors(tx),
    clients: await listClientSummaries(tx),
  }));
  const today = todayIST();
  const sum = (pred: (a: (typeof rows)[number]) => boolean, k: "advised_amount" | "executed_amount" | "pending_amount") =>
    rows.filter(pred).reduce((s, r) => s + r[k], 0);
  const active = (a: (typeof rows)[number]) => !["CANCELLED", "EXPIRED", "REVISED"].includes(a.status);
  const quick = (label: string, params: Record<string, string>) => {
    const q = new URLSearchParams(params).toString();
    return <Link key={label} href={`/advice?${q}`} className="rounded-full bg-white px-3 py-1 text-xs ring-1 ring-border hover:ring-brand">{label}</Link>;
  };

  return (
    <>
      <PageHeader
        title="Advice call ledger"
        subtitle="Every call actually communicated to a client, with exact timestamps. Revised and cancelled calls stay visible."
        actions={actor.role !== "OPERATIONS" ? <LinkButton href="/advice/new">Issue call</LinkButton> : null}
      />
      {one("issued") ? <p className="mb-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">Calls recorded. They now appear below and in Pending Executions.</p> : null}

      <div className="mb-3 flex flex-wrap gap-2">
        {quick("Today", { from: today, to: today })}
        {quick("Sell", { side: "SELL" })}
        {quick("Buy", { side: "BUY" })}
        {quick("Pending", { status: "PENDING" })}
        {quick("Partial", { status: "PARTIAL" })}
        {quick("Executed", { status: "EXECUTED" })}
        {quick("Cancelled / revised", { status: "CANCELLED" })}
      </div>

      <form method="get" className="sticky top-0 z-20 mb-4 flex flex-wrap items-end gap-2 rounded-lg border border-border bg-white/95 p-3 backdrop-blur">
        <label className="text-xs text-muted">From<Input type="date" name="from" defaultValue={f.from ?? ""} className="w-40" /></label>
        <label className="text-xs text-muted">To<Input type="date" name="to" defaultValue={f.to ?? ""} className="w-40" /></label>
        {actor.role !== "ADVISOR" ? (
          <Select name="advisor" defaultValue={f.advisorId ?? ""} className="w-44">
            <option value="">All advisors</option>
            {advisors.map((a) => <option key={a.id} value={a.id}>{a.full_name}</option>)}
          </Select>
        ) : null}
        <Select name="client" defaultValue={f.clientId ?? ""} className="w-52">
          <option value="">All clients</option>
          {clients.map((c) => <option key={c.client_id} value={c.client_id}>{c.full_name}</option>)}
        </Select>
        <Select name="side" defaultValue={f.side ?? ""} className="w-36"><option value="">Buy & sell</option><option value="BUY">Buy</option><option value="SELL">Sell</option></Select>
        <Select name="status" defaultValue={f.status ?? ""} className="w-40">
          <option value="">Any status</option><option value="OPEN">Open (pending/partial)</option><option value="PENDING">Pending</option>
          <option value="PARTIAL">Partial</option><option value="EXECUTED">Executed</option><option value="CANCELLED">Cancelled / revised / expired</option>
        </Select>
        <Button type="submit" variant="outline">Filter</Button>
        <Link href="/advice" className="px-2 text-xs text-muted hover:underline">Reset</Link>
      </form>

      <div className="mb-3 flex flex-wrap gap-6 text-sm">
        <span>{rows.length} calls</span>
        <span>Sell advised <Money value={sum((a) => a.action !== "BUY" && active(a), "advised_amount")} className="font-medium text-red-700" /></span>
        <span>Buy advised <Money value={sum((a) => a.action === "BUY" && active(a), "advised_amount")} className="font-medium text-emerald-700" /></span>
        <span>Executed <Money value={sum(() => true, "executed_amount")} className="font-medium" /></span>
        <span>Pending <Money value={sum(() => true, "pending_amount")} className="font-medium text-amber-700" /></span>
      </div>

      <Card>
        {rows.length ? <AdviceTable rows={rows} /> : <CardContent><EmptyState title="No calls match these filters" /></CardContent>}
      </Card>
    </>
  );
}
