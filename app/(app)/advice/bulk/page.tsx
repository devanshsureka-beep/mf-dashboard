import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import { PageHeader } from "@/components/app/page-header";
import { ADVISORY_ROLES, pageData } from "@/lib/server";
import { listAdvisors, listClientSummaries } from "@/services/clients";
import { RISK_PROFILES } from "@/types/domain";
import { humanize } from "@/lib/format";
import { searchFundsAction } from "../actions";
import { BulkCallForm } from "./bulk-form";

export const metadata = { title: "Call many clients" };

const lakh = (v: string | undefined) => (v && Number(v) > 0 ? Number(v) * 100000 : null);

export default async function BulkCallPage(props: PageProps<"/advice/bulk">) {
  const sp = await props.searchParams;
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const f = {
    minValue: one("min_value"), maxValue: one("max_value"),
    advisor: one("advisor"), risk: one("risk"), plan: one("plan"), q: one("q"),
  };
  const { clients, advisors, actor } = await pageData(async (tx) => ({
    clients: await listClientSummaries(tx, { q: f.q, advisorId: f.advisor || undefined, status: "ACTIVE" }),
    advisors: await listAdvisors(tx),
  }), ADVISORY_ROLES);

  const minValue = lakh(f.minValue), maxValue = lakh(f.maxValue);
  const matching = clients
    .filter((c) => minValue == null || (c.live_portfolio_value ?? 0) >= minValue)
    .filter((c) => maxValue == null || (c.live_portfolio_value ?? 0) <= maxValue)
    .filter((c) => !f.risk || c.risk_profile === f.risk)
    .filter((c) => !f.plan || (f.plan === "yes" ? Boolean(c.active_plan_id) : !c.active_plan_id))
    .sort((a, b) => (b.live_portfolio_value ?? 0) - (a.live_portfolio_value ?? 0));

  return (
    <>
      <PageHeader
        eyebrow="Call ledger"
        title="One call for many clients"
        subtitle="Filter clients (for example by portfolio value or risk), tick them, and record the same call for all of them. Each client gets their own call in the ledger, linked to their plan when the plan has this fund."
      />

      <form method="get" className="mb-4 grid gap-2 rounded-xl border border-border bg-white p-3 sm:grid-cols-2 lg:grid-cols-7">
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

      <BulkCallForm
        clients={matching.map((c) => ({
          id: c.client_id, name: c.full_name, code: c.client_code, advisor: c.advisor_name, risk: c.risk_profile,
          value: c.live_portfolio_value ?? 0, moneyLeft: c.money_left, hasPlan: Boolean(c.active_plan_id),
        }))}
        searchFunds={searchFundsAction}
      />
    </>
  );
}
