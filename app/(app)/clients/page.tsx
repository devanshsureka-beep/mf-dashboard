import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Input, Select } from "@/components/ui/form";
import { Button, LinkButton } from "@/components/ui/button";
import { Money } from "@/components/app/money";
import { StatusBadge } from "@/components/app/status-badge";
import { EmptyState, PageHeader } from "@/components/app/page-header";
import { formatDate } from "@/lib/format";
import { pageData } from "@/lib/server";
import { listAdvisors, listClientSummaries } from "@/services/clients";
import { CLIENT_STATUSES } from "@/types/domain";

export const metadata = { title: "Clients" };

export default async function ClientsPage(props: PageProps<"/clients">) {
  const sp = await props.searchParams;
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const filters = {
    q: one("q"),
    advisorId: one("advisor") || undefined,
    status: one("status") || undefined,
    attention: (one("attention") || undefined) as "pending" | "unadvised" | "no_plan" | undefined,
  };
  const { clients, advisors, actor } = await pageData(async (tx) => ({
    clients: await listClientSummaries(tx, filters),
    advisors: await listAdvisors(tx),
  }));

  const totals = clients.reduce(
    (t, c) => ({
      value: t.value + (c.current_portfolio_value ?? 0),
      targetSell: t.targetSell + c.target_sell,
      pending: t.pending + c.pending_total,
    }),
    { value: 0, targetSell: 0, pending: 0 },
  );

  return (
    <>
      <PageHeader
        title="Clients"
        subtitle={<>{clients.length} clients · <Money value={totals.value} /> under advice · <Money value={totals.pending} /> pending execution</>}
        actions={actor.role !== "OPERATIONS" ? <LinkButton href="/clients/new">New client</LinkButton> : null}
      />

      <form className="sticky top-0 z-20 mb-4 flex flex-wrap items-end gap-2 rounded-lg border border-border bg-white/95 p-3 backdrop-blur" method="get">
        <Input name="q" placeholder="Search name, ID, email, PAN…" defaultValue={filters.q} className="w-72" />
        {actor.role !== "ADVISOR" ? (
          <Select name="advisor" defaultValue={filters.advisorId ?? ""} className="w-48">
            <option value="">All advisors</option>
            {advisors.map((a) => <option key={a.id} value={a.id}>{a.full_name}</option>)}
          </Select>
        ) : null}
        <Select name="status" defaultValue={filters.status ?? ""} className="w-40">
          <option value="">All statuses</option>
          {CLIENT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </Select>
        <Select name="attention" defaultValue={filters.attention ?? ""} className="w-52">
          <option value="">Any</option>
          <option value="pending">Has pending executions</option>
          <option value="unadvised">Has unadvised activity</option>
          <option value="no_plan">No active plan</option>
        </Select>
        <Button type="submit" variant="outline">Apply</Button>
        <Link href="/clients" className="px-2 text-xs text-muted hover:underline">Reset</Link>
      </form>

      <Card>
        {clients.length === 0 ? (
          <div className="p-4"><EmptyState title="No clients match these filters" /></div>
        ) : (
          <Table className="text-[13px] [&_td]:px-2 [&_th]:px-2">
            <THead>
              <TR>
                <TH>Client</TH>
                <TH>Advisor</TH>
                <TH className="text-right">Portfolio</TH>
                <TH>Latest CAS</TH>
                <TH className="text-right">Target exit</TH>
                <TH className="text-right">Target buy</TH>
                <TH className="text-right">Sell advised</TH>
                <TH className="text-right">Sell executed</TH>
                <TH className="text-right">Buy advised</TH>
                <TH className="text-right">Buy executed</TH>
                <TH className="text-right">Pending</TH>
              </TR>
            </THead>
            <TBody>
              {clients.map((c) => (
                <TR key={c.client_id}>
                  <TD>
                    <Link href={`/clients/${c.client_id}`} className="whitespace-nowrap font-medium text-ink hover:underline">{c.full_name}</Link>{" "}
                    {c.status !== "ACTIVE" ? <StatusBadge status={c.status} /> : null}
                    <div className="whitespace-nowrap text-xs text-muted">
                      {c.client_code}
                      {c.unadvised_count > 0 ? <span className="ml-2 text-red-700" title="Unadvised activity detected in CAS">● unadvised</span> : null}
                    </div>
                  </TD>
                  <TD className="whitespace-nowrap">{c.advisor_name ?? "—"}</TD>
                  <TD className="text-right font-medium"><Money value={c.current_portfolio_value} /></TD>
                  <TD className="whitespace-nowrap text-xs">{c.latest_cas_date ? formatDate(c.latest_cas_date) : <span className="text-muted">No CAS</span>}</TD>
                  <TD className="text-right"><Money value={c.target_sell} zeroDash /></TD>
                  <TD className="text-right"><Money value={c.target_buy} zeroDash /></TD>
                  <TD className="text-right text-blue-700"><Money value={c.advised_sell} zeroDash /></TD>
                  <TD className="text-right text-emerald-700"><Money value={c.executed_sell} zeroDash /></TD>
                  <TD className="text-right text-blue-700"><Money value={c.advised_buy} zeroDash /></TD>
                  <TD className="text-right text-emerald-700"><Money value={c.executed_buy} zeroDash /></TD>
                  <TD className="text-right"><Money value={c.pending_total} zeroDash className={c.pending_total > 0 ? "font-medium text-amber-700" : "text-muted"} /></TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </>
  );
}
