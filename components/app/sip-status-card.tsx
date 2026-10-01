import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { formatDate, formatINR } from "@/lib/format";
import type { SipPoint } from "@/lib/domain/sip-status";
import type { SipStatusView } from "@/services/sip-status";

const CHANGE: Record<string, { label: string; tone: "success" | "danger" | "info" | "neutral" | "muted" }> = {
  STARTED: { label: "Started", tone: "success" },
  STOPPED: { label: "Stopped", tone: "danger" },
  AMOUNT_CHANGED: { label: "Amount changed", tone: "info" },
  UNCHANGED: { label: "No change", tone: "muted" },
  FIRST_CAS: { label: "First CAS", tone: "muted" },
};

function Point({ p }: { p: SipPoint | null }) {
  if (!p) return <span className="text-xs text-muted">—</span>;
  if (p.state === "NONE") return <span className="text-xs text-muted">No SIP</span>;
  return (
    <div>
      <span className={p.state === "ACTIVE" ? "font-medium" : "text-muted line-through"}>{formatINR(p.amount)}/mo</span>
      <div className="text-[11px] text-muted">
        {p.state === "ACTIVE" ? "Running" : p.cancelledOn ? `Cancelled ${formatDate(p.cancelledOn)}` : "Stopped"} · last {p.lastInstalment ? formatDate(p.lastInstalment) : "—"}
      </div>
    </div>
  );
}

export function SipStatusCard({ sip }: { sip: SipStatusView }) {
  if (!sip.latestCasDate || (!sip.funds.length && !sip.plan.length)) return null;
  const running = sip.funds.filter((f) => f.now.state === "ACTIVE").reduce((s, f) => s + (f.now.amount ?? 0), 0);
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>SIPs · as per CAS</CardTitle>
          <p className="mt-0.5 text-xs text-muted">
            {sip.previousCasDate ? <>Previous CAS {formatDate(sip.previousCasDate)} → latest CAS {formatDate(sip.latestCasDate)}.</> : <>One CAS so far ({formatDate(sip.latestCasDate)}): the next CAS will show what changed.</>}
            {" "}Running now: <span className="font-medium text-ink">{formatINR(running)}/month</span>. A SIP counts as running when an instalment fell in the last 40 days.
          </p>
        </div>
      </CardHeader>
      {sip.funds.length ? (
        <Table>
          <THead><TR><TH>Fund</TH><TH>Previous CAS</TH><TH>Latest CAS</TH><TH>Change</TH><TH>Plan</TH></TR></THead>
          <TBody>
            {sip.funds.map((f) => {
              const plan = sip.plan.find((p) => p.isin && p.isin === f.isin);
              const c = CHANGE[f.change];
              return (
                <TR key={f.key}>
                  <TD className="max-w-80">
                    <div className="truncate font-medium" title={f.scheme_name}>{f.scheme_name}</div>
                    <div className="text-[11px] text-muted num">{f.folio_number ?? "—"}</div>
                  </TD>
                  <TD><Point p={f.before} /></TD>
                  <TD><Point p={f.now} /></TD>
                  <TD><Badge tone={c.tone}>{c.label}</Badge></TD>
                  <TD>{plan ? <PlanBadge p={plan} /> : <span className="text-xs text-muted">—</span>}</TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      ) : null}
      {sip.plan.filter((p) => !sip.funds.some((f) => p.isin && f.isin === p.isin)).length ? (
        <div className="border-t border-border px-5 py-3">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">Plan SIPs not seen in the CAS yet</div>
          <div className="flex flex-wrap gap-2">
            {sip.plan.filter((p) => !sip.funds.some((f) => p.isin && f.isin === p.isin)).map((p) => (
              <span key={p.id} className="rounded-md border border-border px-2 py-1 text-xs">
                {p.scheme_name} · <PlanBadge p={p} />
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function PlanBadge({ p }: { p: SipStatusView["plan"][number] }) {
  const what = p.action === "STOP" ? "Stop" : p.action === "START" ? `Start ${formatINR(p.new_amount)}` : `Change to ${formatINR(p.new_amount)}`;
  return <Badge tone={p.met ? "success" : "pending"}>{what} · {p.met ? "done" : "pending"}</Badge>;
}
