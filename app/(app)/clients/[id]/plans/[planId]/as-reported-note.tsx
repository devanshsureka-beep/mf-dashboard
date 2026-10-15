import { Money } from "@/components/app/money";
import { formatDateTime } from "@/lib/format";
import type { AsReported } from "@/types/domain";

/** A plan onboarded with the report as it is: why, the differences accepted, and the funds outside the advised portfolio. */
export function AsReportedNote({ a, className }: { a: AsReported; className?: string }) {
  const outsideTotal = a.outside.reduce((t, o) => t + o.value, 0);
  return (
    <section className={`rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 ${className ?? ""}`}>
      <div className="font-semibold">Onboarded with the report as it is</div>
      <p className="mt-0.5">
        {a.reason} <span className="text-xs text-amber-800">· {formatDateTime(a.at)}</span>
      </p>
      <p className="mt-1 text-xs text-amber-900">
        Every line follows the report; a full exit sells the whole holding.
        {a.outside.length ? <> {a.outside.length} CAS fund(s) worth <Money value={outsideTotal} /> are outside the advised portfolio: not plan lines, and their trades are not raised in the CAS inbox.</> : null}
      </p>
      <div className="mt-1.5 flex flex-wrap gap-x-4 text-xs">
        {a.points.length ? (
          <details>
            <summary className="cursor-pointer font-medium">{a.points.length} difference(s) from the CAS accepted</summary>
            <ol className="mt-1 list-decimal space-y-0.5 pl-5">{a.points.map((p, i) => <li key={i}>{p}</li>)}</ol>
          </details>
        ) : null}
        {a.outside.length ? (
          <details>
            <summary className="cursor-pointer font-medium">Outside the advised portfolio</summary>
            <ul className="mt-1 space-y-0.5 pl-1">
              {a.outside.map((o, i) => <li key={i}>{o.scheme_name}{o.folio_number ? ` · folio ${o.folio_number}` : ""} · <Money value={o.value} /></li>)}
            </ul>
          </details>
        ) : null}
      </div>
    </section>
  );
}
