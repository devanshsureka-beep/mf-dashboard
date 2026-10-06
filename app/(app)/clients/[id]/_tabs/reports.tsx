import Link from "next/link";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import type { ClientSummary } from "@/types/domain";

/** One report per month since onboarding (latest first). */
export function ReportsTab({ client: c }: { client: ClientSummary }) {
  const now = new Date();
  const ist = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit" }).format(now);
  const [ey, em] = ist.split("-").map(Number);
  const [sy, sm] = (c.onboarding_date ?? ist).slice(0, 7).split("-").map(Number);
  const months: string[] = [];
  for (let y = ey, m = em; y > sy || (y === sy && m >= sm); m === 1 ? (y--, (m = 12)) : m--) {
    months.push(`${y}-${String(m).padStart(2, "0")}`);
    if (months.length > 120) break;
  }
  const label = (ym: string) => new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${ym}-01T00:00:00Z`));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Monthly reports</CardTitle>
        <span className="text-xs text-muted">What we advised, what was executed, SIPs and the plan, month by month. Open one, add your outlook, then print or save as PDF.</span>
      </CardHeader>
      <div className="grid gap-2 p-4 sm:grid-cols-3 lg:grid-cols-6">
        {months.map((m, i) => (
          <Link key={m} href={`/clients/${c.client_id}/report?month=${m}`} className="rounded-lg border border-border bg-white px-3 py-2 text-sm hover:border-brand-200 hover:bg-brand-50">
            <div className="font-medium">{label(m)}</div>
            <div className="text-[11px] text-muted">{i === 0 ? "This month (so far)" : "Monthly report"}</div>
          </Link>
        ))}
      </div>
    </Card>
  );
}
