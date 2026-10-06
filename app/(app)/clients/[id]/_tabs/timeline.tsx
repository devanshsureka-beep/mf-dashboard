import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Money } from "@/components/app/money";
import { withUserTx, type Actor } from "@/lib/db/tx";
import { formatDateTime, humanize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { getTimeline, TIMELINE_KINDS, type TimelineKind } from "@/services/client-record";

const DOT: Record<TimelineKind, string> = {
  ONBOARDING: "bg-brand", CAS: "bg-sky-500", PLAN: "bg-violet-500", CALL: "bg-blue-600", EXECUTION: "bg-emerald-600",
  MATCHING: "bg-amber-500", SIP: "bg-fuchsia-500", NOTE: "bg-slate-400", DOCUMENT: "bg-slate-500", AGREEMENT: "bg-teal-600", PAYMENT: "bg-green-700",
};

const monthOf = (d: Date) => new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date(d));

/** Every recorded event for the client since onboarding, newest first; filter by kind. */
export async function TimelineTab({ clientId, actor, kind }: { clientId: string; actor: Actor; kind: string | null }) {
  const valid = kind && (TIMELINE_KINDS as readonly string[]).includes(kind) ? kind : null;
  const events = await withUserTx(actor, (tx) => getTimeline(tx, clientId, { kinds: valid ? [valid] : undefined, limit: 1000 }));
  const href = (k: string | null) => `/clients/${clientId}?tab=timeline${k ? `&kind=${k}` : ""}`;

  const groups: { month: string; items: typeof events }[] = [];
  for (const e of events) {
    const m = monthOf(e.at);
    if (groups.at(-1)?.month !== m) groups.push({ month: m, items: [] });
    groups.at(-1)!.items.push(e);
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-4 py-2.5 text-xs">
        <span className="mr-1 font-medium text-muted">Show</span>
        {[null, ...TIMELINE_KINDS].map((k) => (
          <Link key={k ?? "all"} href={href(k)} className={cn("rounded-full px-2.5 py-1 ring-1 ring-border", (k ?? null) === valid ? "bg-brand text-white ring-brand" : "bg-white hover:bg-slate-50")}>
            {k ? humanize(k) : "Everything"}
          </Link>
        ))}
        <span className="ml-auto text-muted">{events.length} event(s)</span>
      </div>
      {events.length === 0 ? <p className="p-4 text-sm text-muted">Nothing recorded{valid ? ` of this kind` : ""}.</p> : (
        <div className="divide-y divide-border">
          {groups.map((g) => (
            <section key={g.month}>
              <h3 className="sticky top-0 z-10 bg-slate-50/95 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted backdrop-blur">{g.month}</h3>
              <ol className="px-4">
                {g.items.map((e, i) => (
                  <li key={`${e.kind}-${i}-${String(e.at)}`} className="flex gap-3 py-2">
                    <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", DOT[e.kind])} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        {e.href ? <Link href={e.href} prefetch={e.href.startsWith("/api/") ? false : undefined} className="truncate text-sm font-medium hover:underline">{e.title}</Link> : <span className="truncate text-sm font-medium">{e.title}</span>}
                        {e.amount !== null ? <span className="text-sm font-semibold"><Money value={e.amount} full /></span> : null}
                      </div>
                      {e.detail ? <div className="truncate text-xs text-muted" title={e.detail}>{e.detail}</div> : null}
                    </div>
                    <div className="shrink-0 text-right text-[11px] text-muted">
                      <div>{formatDateTime(e.at)}</div>
                      <div>{humanize(e.kind)}{e.who ? ` · ${e.who}` : ""}</div>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}
    </Card>
  );
}
