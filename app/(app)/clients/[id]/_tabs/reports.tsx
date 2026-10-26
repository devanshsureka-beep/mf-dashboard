import Link from "next/link";
import { quarterLabel } from "@/lib/domain/quarterly";
import type { ClientSummary } from "@/types/domain";
import { reviewQuarters } from "@/services/quarterly-review";

/** Reports tile: the latest two monthly reports and the quarterly reviews, older ones folded. */
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
  const quarters = reviewQuarters(c.onboarding_date ? String(c.onboarding_date).slice(0, 10) : null, new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now));
  const label = (ym: string) => new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${ym}-01T00:00:00Z`));
  return (
    <section id="reports" className="scroll-mt-14 rounded-xl border border-border bg-surface px-4 py-3">
      <div className="text-[10.5px] font-semibold uppercase tracking-wide text-muted">Monthly reports</div>
      <ul className="mt-1 space-y-0.5 text-sm">
        {months.slice(0, 2).map((m, i) => (
          <li key={m}><Link href={`/clients/${c.client_id}/report?month=${m}`} className="font-medium text-brand hover:underline">{label(m)}{i === 0 ? " (so far)" : ""} →</Link></li>
        ))}
      </ul>
      {months.length > 2 ? (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-muted">Older months · {months.length - 2}</summary>
          <ul className="mt-1 space-y-0.5 text-xs">
            {months.slice(2).map((m) => <li key={m}><Link href={`/clients/${c.client_id}/report?month=${m}`} className="text-brand hover:underline">{label(m)}</Link></li>)}
          </ul>
        </details>
      ) : null}
      <div className="mt-3 text-[10.5px] font-semibold uppercase tracking-wide text-muted">Quarterly reviews</div>
      <ul className="mt-1 space-y-0.5 text-sm">
        {quarters.slice(0, 2).map((q) => (
          <li key={q}><Link href={`/clients/${c.client_id}/quarterly?q=${q}`} className="font-medium text-brand hover:underline">{quarterLabel(q)} →</Link></li>
        ))}
      </ul>
      {quarters.length > 2 ? (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-muted">Older quarters · {quarters.length - 2}</summary>
          <ul className="mt-1 space-y-0.5 text-xs">
            {quarters.slice(2).map((q) => <li key={q}><Link href={`/clients/${c.client_id}/quarterly?q=${q}`} className="text-brand hover:underline">{quarterLabel(q)}</Link></li>)}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
