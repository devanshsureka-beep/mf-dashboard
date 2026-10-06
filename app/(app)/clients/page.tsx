import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/form";
import { Button, LinkButton } from "@/components/ui/button";
import { Money } from "@/components/app/money";
import { StatusBadge } from "@/components/app/status-badge";
import { EmptyState, PageHeader } from "@/components/app/page-header";
import { formatDate, formatINRCompact, humanize } from "@/lib/format";
import { pageData } from "@/lib/server";
import { cn } from "@/lib/utils";
import { listAdvisors, listDeskClients, type DeskFilters } from "@/services/clients";
import { CLIENT_STATUSES, RISK_PROFILES } from "@/types/domain";

export const metadata = { title: "Premium clients" };

const lakh = (v: string | undefined) => (v && Number(v) > 0 ? Number(v) * 100000 : null);

function Chip({ href, active, tone, children }: { href: string; active: boolean; tone: "red" | "amber" | "blue" | "slate"; children: React.ReactNode }) {
  const tones = { red: "text-red-700", amber: "text-amber-800", blue: "text-blue-700", slate: "text-slate-700" };
  return (
    <Link href={href} className={cn("rounded-full border px-3 py-1 text-xs font-medium", active ? "border-brand bg-brand text-white" : `border-border bg-white hover:bg-slate-50 ${tones[tone]}`)}>
      {children}
    </Link>
  );
}

export default async function ClientsPage(props: PageProps<"/clients">) {
  const sp = await props.searchParams;
  const one = (k: string) => (typeof sp[k] === "string" && sp[k] ? (sp[k] as string) : undefined);
  const f: DeskFilters = {
    q: one("q"), advisorId: /^[0-9a-f-]{36}$/i.test(one("advisor") ?? "") ? one("advisor") : undefined,
    status: (CLIENT_STATUSES as readonly string[]).includes(one("status") ?? "") ? one("status") : undefined,
    risk: (RISK_PROFILES as readonly string[]).includes(one("risk") ?? "") ? one("risk") : undefined,
    plan: one("plan") as DeskFilters["plan"], premium: one("premium") as DeskFilters["premium"],
    agreement: one("agreement") as DeskFilters["agreement"], attention: one("attention") as DeskFilters["attention"],
    minValue: lakh(one("min")), maxValue: lakh(one("max")), sort: (one("sort") as DeskFilters["sort"]) ?? "name",
  };
  const { clients, all, advisors, actor } = await pageData(async (tx) => ({
    clients: await listDeskClients(tx, f),
    all: await listDeskClients(tx, {}),
    advisors: await listAdvisors(tx),
  }));

  const count = (pred: (c: (typeof all)[number]) => boolean) => all.filter(pred).length;
  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...Object.fromEntries(Object.entries(sp).filter(([, v]) => typeof v === "string")), ...patch })) if (v) p.set(k, v as string);
    const s = p.toString();
    return `/clients${s ? `?${s}` : ""}`;
  };
  const totals = clients.reduce((t, c) => ({ value: t.value + (c.live_portfolio_value ?? 0), pending: t.pending + c.pending_total, premium: t.premium + c.premium_paid_total }), { value: 0, pending: 0, premium: 0 });
  const activeFilters = Object.entries(sp).filter(([k, v]) => typeof v === "string" && v && k !== "sort").length;

  return (
    <>
      <PageHeader
        title="Premium clients"
        subtitle={<>{clients.length} of {all.length} clients · <Money value={totals.value} /> under advice · <Money value={totals.pending} /> pending execution · <Money value={totals.premium} /> premium received</>}
        actions={actor.role !== "OPERATIONS" ? <LinkButton href="/clients/new">New client</LinkButton> : null}
      />

      {/* One-click views of what needs work */}
      <div className="mb-2 flex flex-wrap gap-1.5">
        <Chip href={qs({ attention: f.attention === "unadvised" ? undefined : "unadvised" })} active={f.attention === "unadvised"} tone="red">Unadvised trades to review · {count((c) => c.unadvised_to_review > 0)}</Chip>
        <Chip href={qs({ attention: f.attention === "pending" ? undefined : "pending" })} active={f.attention === "pending"} tone="amber">Pending executions · {count((c) => c.pending_total > 0)}</Chip>
        <Chip href={qs({ attention: f.attention === "cas_review" ? undefined : "cas_review" })} active={f.attention === "cas_review"} tone="amber">CAS to check · {count((c) => c.cas_to_review > 0)}</Chip>
        <Chip href={qs({ attention: f.attention === "follow_up" ? undefined : "follow_up" })} active={f.attention === "follow_up"} tone="amber">Follow-ups due · {count((c) => c.follow_ups_due > 0)}</Chip>
        <Chip href={qs({ plan: f.plan === "draft" ? undefined : "draft" })} active={f.plan === "draft"} tone="blue">Draft plans · {count((c) => c.has_draft_plan)}</Chip>
        <Chip href={qs({ premium: f.premium === "renewal_due" ? undefined : "renewal_due" })} active={f.premium === "renewal_due"} tone="amber">Renewal due (30 days) · {count((c) => c.renewal_due)}</Chip>
        <Chip href={qs({ premium: f.premium === "expired" ? undefined : "expired" })} active={f.premium === "expired"} tone="red">Premium expired · {count((c) => c.premium_status === "EXPIRED")}</Chip>
        <Chip href={qs({ agreement: f.agreement === "missing" ? undefined : "missing" })} active={f.agreement === "missing"} tone="red">No valid agreement · {count((c) => c.agreement_status !== "VALID")}</Chip>
      </div>

      <form className="sticky top-0 z-20 mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-white/95 p-2.5 backdrop-blur" method="get">
        <Input name="q" placeholder="Name, client ID, PAN, phone, email…" defaultValue={f.q} className="h-9 w-72" aria-label="Search" />
        {actor.role !== "ADVISOR" ? (
          <Select name="advisor" defaultValue={f.advisorId ?? ""} className="h-9 w-44" aria-label="Advisor">
            <option value="">All advisors</option>
            {advisors.map((a) => <option key={a.id} value={a.id}>{a.full_name}</option>)}
          </Select>
        ) : null}
        <Select name="status" defaultValue={f.status ?? ""} className="h-9 w-36" aria-label="Status">
          <option value="">Any status</option>
          {CLIENT_STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
        </Select>
        <Select name="risk" defaultValue={f.risk ?? ""} className="h-9 w-48" aria-label="Risk profile">
          <option value="">Any risk</option>
          {RISK_PROFILES.map((r) => <option key={r} value={r}>{humanize(r)}</option>)}
        </Select>
        <Select name="plan" defaultValue={f.plan ?? ""} className="h-9 w-40" aria-label="Plan">
          <option value="">Any plan</option><option value="active">Active plan</option><option value="draft">Draft to approve</option><option value="none">No active plan</option>
        </Select>
        <Select name="premium" defaultValue={f.premium ?? ""} className="h-9 w-40" aria-label="Premium">
          <option value="">Any premium</option><option value="active">Premium active</option><option value="renewal_due">Renewal due</option><option value="expired">Expired</option><option value="unpaid">Not recorded</option>
        </Select>
        <Input name="min" inputMode="decimal" placeholder="Value ≥ ₹L" defaultValue={one("min")} className="h-9 w-28" aria-label="Minimum value in lakh" />
        <Input name="max" inputMode="decimal" placeholder="Value ≤ ₹L" defaultValue={one("max")} className="h-9 w-28" aria-label="Maximum value in lakh" />
        <Select name="sort" defaultValue={f.sort} className="h-9 w-44" aria-label="Sort">
          <option value="name">Sort: name</option><option value="code">Client ID</option><option value="value">Value (high first)</option>
          <option value="pending">Pending (high first)</option><option value="onboarded">Newest onboarded</option><option value="renewal">Renewal (soonest)</option>
        </Select>
        {f.attention ? <input type="hidden" name="attention" value={f.attention} /> : null}
        {f.agreement ? <input type="hidden" name="agreement" value={f.agreement} /> : null}
        <div className="flex items-center gap-2">
          <Button type="submit" variant="outline" size="sm">Apply</Button>
          {activeFilters ? <Link href="/clients" className="text-xs text-muted hover:underline">Clear</Link> : null}
        </div>
      </form>

      <Card>
        {clients.length === 0 ? (
          <div className="p-4"><EmptyState title="No clients match these filters" /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="border-b border-border bg-slate-50 text-left text-[10.5px] font-semibold uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-3 py-2">Client</th>
                  <th className="px-2 py-2">Advisor · risk</th>
                  <th className="px-2 py-2 text-right">Value today</th>
                  <th className="px-2 py-2">Rebalancing</th>
                  <th className="px-2 py-2 text-right">Pending</th>
                  <th className="px-2 py-2 text-right">SIP / mo</th>
                  <th className="px-2 py-2">Premium</th>
                  <th className="px-2 py-2">Latest CAS</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {clients.map((c) => {
                  const target = c.target_sell + c.target_buy;
                  const done = target > 0 ? Math.round(((c.executed_sell + c.executed_buy) / target) * 100) : null;
                  const advised = target > 0 ? Math.round(((c.advised_sell + c.advised_buy) / target) * 100) : 0;
                  return (
                    <tr key={c.client_id} className="hover:bg-slate-50/70">
                      <td className="px-3 py-2">
                        <Link href={`/clients/${c.client_id}`} className="font-medium text-ink hover:underline">{c.full_name}</Link>
                        <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted">
                          <span className="font-mono">{c.client_code}</span>
                          {c.status !== "ACTIVE" ? <StatusBadge status={c.status} /> : null}
                          {c.unadvised_to_review ? <Link href={`/clients/${c.client_id}?tab=cas`} className="rounded bg-red-50 px-1 text-red-700">{c.unadvised_to_review} unadvised</Link> : null}
                          {c.cas_to_review ? <span className="rounded bg-amber-50 px-1 text-amber-800">CAS to check</span> : null}
                          {c.has_draft_plan ? <span className="rounded bg-blue-50 px-1 text-blue-700">draft plan</span> : null}
                          {c.follow_ups_due ? <span className="rounded bg-amber-50 px-1 text-amber-800">{c.follow_ups_due} follow-up</span> : null}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-xs">{c.advisor_name ?? "—"}<div className="text-muted">{humanize(c.risk_profile)}</div></td>
                      <td className="px-2 py-2 text-right font-semibold"><Money value={c.live_portfolio_value} /></td>
                      <td className="w-44 px-2 py-2">
                        {done === null ? <span className="text-xs text-muted">{c.active_plan_id ? "No targets" : "No active plan"}</span> : (
                          <>
                            <div className="flex justify-between text-[11px]"><span className="text-emerald-700">{done}% done</span><span className="text-muted">of {formatINRCompact(target)}</span></div>
                            <div className="mt-0.5 h-1.5 rounded-full bg-slate-100">
                              <div className="relative h-1.5 rounded-full bg-blue-200" style={{ width: `${Math.min(advised, 100)}%` }}>
                                <div className="absolute inset-y-0 left-0 rounded-full bg-emerald-500" style={{ width: advised ? `${Math.min((done / advised) * 100, 100)}%` : "0%" }} />
                              </div>
                            </div>
                          </>
                        )}
                      </td>
                      <td className="px-2 py-2 text-right"><Money value={c.pending_total} zeroDash className={c.pending_total > 0 ? "font-medium text-amber-700" : "text-muted"} /></td>
                      <td className="px-2 py-2 text-right"><Money value={c.sip_monthly_target} zeroDash className="text-violet-700" /></td>
                      <td className="whitespace-nowrap px-2 py-2 text-xs">
                        <Money value={c.premium_paid_total} zeroDash />
                        <div className={c.premium_status === "ACTIVE" ? (c.renewal_due ? "text-amber-700" : "text-emerald-700") : "text-red-700"}>
                          {c.paid_until ? `${c.premium_status === "EXPIRED" ? "expired" : "till"} ${formatDate(c.paid_until)}` : c.premium_status === "UNPAID" ? "not recorded" : "no period"}
                        </div>
                        {c.agreement_status !== "VALID" ? <div className="text-red-700">agreement {c.agreement_status === "EXPIRED" ? "expired" : "missing"}</div> : null}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-xs">{c.latest_cas_date ? formatDate(c.latest_cas_date) : <span className="text-muted">No CAS</span>}<div className="text-muted">since {formatDate(c.onboarding_date)}</div></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
