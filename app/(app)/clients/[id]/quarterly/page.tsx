import Link from "next/link";
import { PageHeader } from "@/components/app/page-header";
import { dayMon, isQuarterEnd, quarterLabel } from "@/lib/domain/quarterly";
import type { QuarterlyReport } from "@/lib/domain/quarterly-report";
import { AppError } from "@/lib/errors";
import { formatDateTime } from "@/lib/format";
import { pagesOf } from "@/lib/pdf/quarterly-review";
import { buildReviewFor } from "@/lib/quarterly-build";
import { pageData } from "@/lib/server";
import { cn } from "@/lib/utils";
import { getClientSummary } from "@/services/clients";
import { listBenchmarks, reviewQuarters } from "@/services/quarterly-review";
import { saveQuarterlyPageAction } from "./actions";
import { ReviewPages } from "./review-pages";

export const metadata = { title: "Quarterly review" };
// The first build for a client may fetch past NAVs; the page itself never waits for that.
export const maxDuration = 60;

const box = "rounded-xl border border-border bg-surface p-4";

/** Quarterly review: pick the quarter, read and edit the review on its own pages, download the PDF. */
export default async function QuarterlyReviewPage(props: PageProps<"/clients/[id]/quarterly">) {
  const { id } = await props.params;
  const sp = await props.searchParams;
  const { c, benchmarks, today, actor } = await pageData(async (tx) => ({
    c: await getClientSummary(tx, id),
    benchmarks: await listBenchmarks(tx),
    today: (await tx<{ d: string }[]>`select app.today_ist()::text as d`)[0].d,
  }));
  const quarters = reviewQuarters(c.onboarding_date ? String(c.onboarding_date).slice(0, 10) : null, today);
  const q = typeof sp.q === "string" && isQuarterEnd(sp.q) ? sp.q : quarters[0];
  const canEdit = actor.role !== "OPERATIONS";
  const pdf = `/api/clients/${id}/quarterly?q=${q}`;

  let built: Awaited<ReturnType<typeof buildReviewFor>> | null = null;
  let problem: string | null = null;
  try {
    built = await buildReviewFor(actor, id, q, { fetchNavs: false });
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    problem = e.message;
  }

  return (
    <>
      <PageHeader
        eyebrow={<><Link href="/clients" className="hover:underline">Clients</Link> › <Link href={`/clients/${id}`} className="hover:underline">{c.full_name}</Link> › Quarterly review</>}
        title="Quarterly review"
        subtitle="The review exactly as the client gets it. Numbers come from the plan, calls, CAS and NAVs; press Edit to write on the pages what only you know. The PDF prints these same pages."
        actions={built ? (
          <div className="flex gap-2">
            <a href={`${pdf}&preview=1`} target="_blank" rel="noreferrer" className="rounded-md border border-border bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50">Preview PDF</a>
            {canEdit ? (
              built.report.checks.errors.length
                ? <span className="cursor-not-allowed rounded-md bg-slate-200 px-3 py-1.5 text-sm font-semibold text-slate-500" title="Fix the errors below first">Download PDF</span>
                : <a href={pdf} className="rounded-md bg-brand px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700">Download PDF</a>
            ) : null}
          </div>
        ) : null}
      />

      <nav className="mb-4 flex flex-wrap items-center gap-1.5 text-sm" aria-label="Quarter">
        {quarters.slice(0, 8).map((x) => (
          <Link key={x} href={`/clients/${id}/quarterly?q=${x}`} aria-current={x === q ? "page" : undefined}
            className={cn("rounded-full px-3 py-1 ring-1", x === q ? "bg-brand-50 font-semibold text-brand-700 ring-brand" : "bg-white text-slate-700 ring-border hover:ring-brand-200")}>
            {quarterLabel(x)}
          </Link>
        ))}
      </nav>

      {sp.blocked ? <p role="alert" className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">The download was stopped: fix the errors below, then download again.</p> : null}
      {typeof sp.error === "string" ? <p role="alert" className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{sp.error}</p> : null}
      {problem ? <p role="alert" className={cn(box, "text-sm text-red-700")}>{problem}</p> : null}

      {built ? <Review r={built.report} g={built.generated} ctx={built.context} navMissing={built.navMissing} canEdit={canEdit} id={id} q={q} benchmarks={benchmarks} /> : null}
    </>
  );
}

function Review({ r, g, ctx, navMissing, canEdit, id, q, benchmarks }: {
  r: QuarterlyReport; g: QuarterlyReport; ctx: NonNullable<Awaited<ReturnType<typeof buildReviewFor>>>["context"]; navMissing: number; canEdit: boolean;
  id: string; q: string; benchmarks: { code: string; name: string }[];
}) {
  const pages = pagesOf(r);
  return (
    <div className="grid gap-4">
      <section className={box}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Review {r.reviewNo} · {quarterLabel(q)} · {pages.length} pages</h2>
          <span className="text-xs text-muted">Period {dayMon(r.windowStart, true)} – {dayMon(r.windowEnd, true)} · CAS of {dayMon(r.casDate, true)} · NAVs of {dayMon(r.asOf, true)}</span>
        </div>
        {r.checks.errors.length ? (
          <ul className="mt-3 space-y-1 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {r.checks.errors.map((e) => <li key={e}>Must fix: {e}</li>)}
          </ul>
        ) : <p className="mt-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">Ready to download: totals add up and no internal terms or other clients’ names are in the text.</p>}
        {r.checks.warnings.length || navMissing ? (
          <ul className="mt-2 space-y-1 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {navMissing ? <li>Past NAVs for {navMissing} scheme(s) are not loaded yet. They load when you preview or download (up to a minute the first time).</li> : null}
            {r.checks.warnings.map((w) => <li key={w}>Check: {w}</li>)}
          </ul>
        ) : null}
        {ctx.carriedFrom ? <p className="mt-2 text-xs text-muted">Fund statuses and rates carried over from the {quarterLabel(ctx.carriedFrom)} review.</p> : null}
        {ctx.files.length ? (
          <div className="mt-3 text-sm">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Downloaded</div>
            <ul className="mt-1 space-y-0.5">
              {ctx.files.map((f) => (
                <li key={f.id}><a className="text-brand hover:underline" href={`/api/clients/${id}/quarterly/file/${f.id}`}>{f.file_name}</a> <span className="text-xs text-muted">· period to {dayMon(f.as_of, true)} · {formatDateTime(f.created_at)}{f.created_by_name ? ` · ${f.created_by_name}` : ""}</span></li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <ReviewPages report={r} generated={g} inputs={ctx.inputs} market={ctx.market} benchmarks={benchmarks} canEdit={canEdit} save={saveQuarterlyPageAction.bind(null, id, q)} />
    </div>
  );
}
