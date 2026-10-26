import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { PageHeader } from "@/components/app/page-header";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { FUND_STATUSES, fieldKey } from "@/lib/domain/quarterly-inputs";
import { dayMon, DEFAULT_RATES, isQuarterEnd, quarterLabel } from "@/lib/domain/quarterly";
import type { QuarterlyReport } from "@/lib/domain/quarterly-report";
import { AppError } from "@/lib/errors";
import { formatDateTime, formatINR, formatINRCompact } from "@/lib/format";
import { pagesOf } from "@/lib/pdf/quarterly-review";
import { buildReviewFor } from "@/lib/quarterly-build";
import { pageData } from "@/lib/server";
import { cn } from "@/lib/utils";
import { getClientSummary } from "@/services/clients";
import { listBenchmarks, reviewQuarters } from "@/services/quarterly-review";
import { saveMarketAction, saveQuarterlyAction } from "./actions";

export const metadata = { title: "Quarterly review" };
// The first build for a client may fetch past NAVs; the page itself never waits for that.
export const maxDuration = 60;

const box = "rounded-xl border border-border bg-surface p-4";
const h2 = "mb-3 text-sm font-semibold text-ink";

/** Quarterly review: pick the quarter, write what only the advisor knows, preview and download the PDF. */
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
  const base = `/clients/${id}/quarterly?q=${q}`;
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
        subtitle="The client's quarterly portfolio review as a PDF. Numbers come from the plan, calls, CAS and NAVs; write only what you know that the numbers don't. Blank fields keep the text shown in grey."
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

      {built ? <Review r={built.report} g={built.generated} ctx={built.context} navMissing={built.navMissing} canEdit={canEdit} id={id} q={q} base={base} benchmarks={benchmarks} /> : null}
    </>
  );
}

function Review({ r, g, ctx, navMissing, canEdit, id, q, benchmarks }: {
  r: QuarterlyReport; g: QuarterlyReport; ctx: NonNullable<Awaited<ReturnType<typeof buildReviewFor>>>["context"]; navMissing: number; canEdit: boolean;
  id: string; q: string; base: string; benchmarks: { code: string; name: string }[];
}) {
  const inp = ctx.inputs;
  const pages = pagesOf(r);
  const dis = !canEdit;
  const benchName = (code: string | null) => benchmarks.find((b) => b.code === code)?.name ?? "No index";
  return (
    <div className="grid gap-4">
      <section className={box}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Review {r.reviewNo} · {quarterLabel(q)} · {pages.length} pages</h2>
          <span className="text-xs text-muted">Period {dayMon(r.windowStart, true)} – {dayMon(r.windowEnd, true)} · CAS of {dayMon(r.casDate, true)} · NAVs of {dayMon(r.asOf, true)}</span>
        </div>
        <p className="mt-1 text-xs text-muted">{pages.join(" · ")}</p>
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

      <ActionForm action={saveQuarterlyAction.bind(null, id, q)} className="grid gap-4">
        <fieldset disabled={dis} className="contents">
          <section className={box}>
            <h2 className={h2}>Cover and the review in one line</h2>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Cover line"><Input name="tagline" defaultValue={inp.tagline ?? ""} placeholder={g.texts.tagline} maxLength={140} /></Field>
              <Field label="The review in one line"><Input name="headline" defaultValue={inp.headline ?? ""} placeholder={g.texts.headline} maxLength={220} /></Field>
              <Field label="Review at a glance (one paragraph per line)" className="md:col-span-2"><Textarea name="glance" rows={3} defaultValue={inp.glance ?? ""} placeholder={g.texts.glance.join("\n")} maxLength={900} /></Field>
            </div>
          </section>

          <section className={box}>
            <h2 className={h2}>The story so far</h2>
            <div className="grid gap-2 md:grid-cols-5">
              {g.story.map((card, i) => (
                <div key={i} className="grid gap-1.5">
                  <Input name={`story.${i}.when`} defaultValue={inp.story?.[i]?.when ?? ""} placeholder={card.when} maxLength={24} aria-label={`Card ${i + 1} when`} />
                  <Input name={`story.${i}.title`} defaultValue={inp.story?.[i]?.title ?? ""} placeholder={card.title} maxLength={40} aria-label={`Card ${i + 1} title`} />
                  <Textarea name={`story.${i}.text`} rows={5} defaultValue={inp.story?.[i]?.text ?? ""} placeholder={card.text} maxLength={320} aria-label={`Card ${i + 1} text`} />
                </div>
              ))}
            </div>
            <Field label="In one sentence (optional; left out when blank)" className="mt-3"><Input name="storySentence" defaultValue={inp.storySentence ?? ""} maxLength={400} /></Field>
          </section>

          <section className={box}>
            <h2 className={h2}>Market, plan and new money</h2>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="What the market means for this client"><Textarea name="marketNote" rows={3} defaultValue={inp.marketNote ?? ""} placeholder={g.texts.marketNote || "Fill the quarter's valuation table below; its note shows here unless you write one for this client."} maxLength={600} /></Field>
              <Field label="Plan vs execution note"><Textarea name="planCallout" rows={3} defaultValue={inp.planCallout ?? ""} placeholder={g.texts.planCallout} maxLength={400} /></Field>
              <Field label="Funds ahead of their index (green note)"><Textarea name="winnersNote" rows={2} defaultValue={inp.winnersNote ?? ""} placeholder={g.texts.winnersNote || "Shown once the index history is loaded."} maxLength={300} /></Field>
              <Field label="Funds behind their index (amber note)"><Textarea name="laggardNote" rows={2} defaultValue={inp.laggardNote ?? ""} placeholder={g.texts.laggardNote || "No fund behind its index."} maxLength={300} /></Field>
              {g.old ? <Field label="Old vs new note" className="md:col-span-2"><Textarea name="oldVsNewNote" rows={2} defaultValue={inp.oldVsNewNote ?? ""} placeholder={g.texts.oldVsNewNote} maxLength={400} /></Field> : null}
            </div>
          </section>

          <section className={box}>
            <h2 className={h2}>Fund health check</h2>
            <p className="mb-2 text-xs text-muted">Status and the reason come from your research. The index is set per fund for every client (the default follows the fund’s category).</p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead><tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted"><th className="py-1.5">Fund</th><th className="text-right">Value</th><th className="pl-3">Status</th><th className="pl-3">Why</th><th className="pl-3">Compared with</th></tr></thead>
                <tbody>
                  {r.health.map((h) => {
                    const gen = g.health.find((x) => x.key === h.key);
                    return (
                      <tr key={h.key} className="border-b border-slate-100 align-top">
                        <td className="py-1.5 pr-2 font-medium">{h.name}</td>
                        <td className="py-1.5 text-right tabular-nums">{formatINRCompact(h.value)}</td>
                        <td className="py-1 pl-3">
                          <Select name={`funds.${fieldKey(h.key)}.status`} defaultValue={inp.funds?.[h.key]?.status ?? ""} className="w-28">
                            <option value="">{gen?.status ? `${gen.status} (auto)` : "—"}</option>
                            {FUND_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                          </Select>
                        </td>
                        <td className="py-1 pl-3"><Input name={`funds.${fieldKey(h.key)}.why`} defaultValue={inp.funds?.[h.key]?.why ?? ""} placeholder={gen?.why || "Why (shown in the PDF)"} maxLength={140} /></td>
                        <td className="py-1 pl-3">
                          {h.isin ? (
                            <>
                              <input type="hidden" name={`$was.index.${h.isin}`} value={h.indexIsDefault ? "" : h.index ?? "NONE"} />
                              <Select name={`index.${h.isin}`} defaultValue={h.indexIsDefault ? "" : h.index ?? "NONE"} className="w-44">
                                <option value="">Default{h.indexIsDefault ? ` (${benchName(h.index)})` : ""}</option>
                                {benchmarks.map((b) => <option key={b.code} value={b.code}>{b.name}</option>)}
                                <option value="NONE">No index</option>
                              </Select>
                            </>
                          ) : <span className="text-xs text-muted">{benchName(h.index)}</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {r.rebalance?.buys.length ? (
            <section className={box}>
              <h2 className={h2}>Rebalance: what we buy</h2>
              <p className="mb-2 text-xs text-muted">From the plan lines still to do. Check each fund’s lumpsum and SIP are open on the order screen.</p>
              <div className="grid gap-2">
                {r.rebalance.buys.map((b) => (
                  <div key={b.key} className="grid items-center gap-2 md:grid-cols-[1.4fr_0.6fr_0.6fr_0.6fr_2fr]">
                    <span className="text-sm font-medium">{b.name} <span className="text-xs text-muted">{formatINR(b.amount)}</span></span>
                    <Select name={`lumpsum.${fieldKey(b.key)}`} defaultValue={inp.lumpsum?.[b.key] ?? ""} aria-label={`Lumpsum ${b.name}`}><option value="">Lumpsum: confirm</option><option value="OPEN">Lumpsum OPEN</option><option value="PAUSED">Lumpsum PAUSED</option></Select>
                    <Select name={`sipOpen.${fieldKey(b.key)}`} defaultValue={inp.sipOpen?.[b.key] ?? ""} aria-label={`SIP ${b.name}`}><option value="">SIP: OPEN</option><option value="OPEN">SIP OPEN</option><option value="PAUSED">SIP PAUSED</option></Select>
                    <span />
                    <Input name={`buyWhy.${fieldKey(b.key)}`} defaultValue={inp.buyWhy?.[b.key] ?? ""} placeholder={g.rebalance?.buys.find((x) => x.key === b.key)?.why || "Why"} maxLength={90} />
                  </div>
                ))}
              </div>
              <Field label="Note under the buy table" className="mt-3"><Input name="rebalanceNote" defaultValue={inp.rebalanceNote ?? ""} maxLength={300} /></Field>
            </section>
          ) : null}

          <section className={box}>
            <h2 className={h2}>Structure and SIP</h2>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="What changes in the structure"><Textarea name="structureNote" rows={3} defaultValue={inp.structureNote ?? ""} placeholder={g.texts.structureNote} maxLength={700} /></Field>
              <Field label="SIP note"><Textarea name="sipNote" rows={3} defaultValue={inp.sipNote ?? ""} placeholder={g.texts.sipNote || "No SIP in the plan."} maxLength={400} /></Field>
              <Field label="No new money into (comma separated)" className="md:col-span-2"><Input name="noNewMoney" defaultValue={inp.noNewMoney ?? ""} placeholder={g.sip.noNewMoney.join(", ")} maxLength={200} /></Field>
            </div>
            {r.sip.rows.length ? (
              <div className="mt-3 grid gap-2">
                {r.sip.rows.map((s) => (
                  <div key={s.id} className="grid items-center gap-2 md:grid-cols-[1.4fr_2fr]">
                    <span className="text-sm">{s.name} <span className="text-xs text-muted">{s.amount ? `${formatINR(s.amount)}/month` : "Stop"}</span></span>
                    <Input name={`sipWhy.${fieldKey(s.id)}`} defaultValue={inp.sipWhy?.[s.id] ?? ""} placeholder={g.sip.rows.find((x) => x.id === s.id)?.why || "Why"} maxLength={90} aria-label={`Why ${s.name}`} />
                  </div>
                ))}
              </div>
            ) : null}
          </section>

          <section className={box}>
            <h2 className={h2}>Tax and projections</h2>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Tax notes (one per line)"><Textarea name="taxNotes" rows={3} defaultValue={inp.taxNotes ?? ""} placeholder={g.texts.taxNotes.slice(0, -1).join("\n")} maxLength={700} /></Field>
              <Field label="Estimated exit load (₹)" hint="Exit loads are not in the CAS."><Input name="exitLoad" inputMode="decimal" defaultValue={inp.exitLoad ?? ""} placeholder="0" /></Field>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
              {(["bear", "nifty", "base", "moonshot"] as const).map((k) => (
                <Field key={k} label={`${k === "nifty" ? "Nifty 50" : k[0].toUpperCase() + k.slice(1)} rate (%)`}>
                  <Input name={`rates.${k}`} inputMode="decimal" defaultValue={inp.rates?.[k] ?? ""} placeholder={String(+(DEFAULT_RATES[k] * 100).toFixed(1))} />
                </Field>
              ))}
            </div>
          </section>

          <section className={box}>
            <h2 className={h2}>Action plan</h2>
            <p className="mb-2 text-xs text-muted">Grey rows are made from the plan. Write any row and the PDF uses only the rows you wrote.</p>
            <div className="grid gap-2">
              {Array.from({ length: 7 }, (_, i) => {
                const a = g.actions[i];
                return (
                  <div key={i} className="grid gap-2 md:grid-cols-[1.2fr_2.4fr_0.8fr]">
                    <Input name={`actions.${i}.title`} defaultValue={inp.actions?.[i]?.title ?? ""} placeholder={a?.title ?? "Action"} maxLength={90} aria-label={`Action ${i + 1}`} />
                    <Input name={`actions.${i}.detail`} defaultValue={inp.actions?.[i]?.detail ?? ""} placeholder={a?.detail ?? "Detail"} maxLength={260} aria-label={`Action ${i + 1} detail`} />
                    <Input name={`actions.${i}.when`} defaultValue={inp.actions?.[i]?.when ?? ""} placeholder={a?.when ?? "When"} maxLength={30} aria-label={`Action ${i + 1} when`} />
                  </div>
                );
              })}
            </div>
            <div className="mt-3 grid gap-3 md:grid-cols-[1fr_3fr]">
              <Field label="Next review"><Input name="nextReview" defaultValue={inp.nextReview ?? ""} placeholder={g.texts.nextReview} maxLength={40} /></Field>
              <Field label="Next review note"><Input name="nextReviewNote" defaultValue={inp.nextReviewNote ?? ""} placeholder={g.texts.nextReviewNote} maxLength={240} /></Field>
            </div>
          </section>
        </fieldset>
        {canEdit ? <div className="sticky bottom-0 -mx-1 flex justify-end bg-gradient-to-t from-background via-background px-1 py-2"><SubmitButton>Save review</SubmitButton></div> : null}
      </ActionForm>

      <ActionForm action={saveMarketAction.bind(null, id, q)} className={box}>
        <h2 className={h2}>The quarter’s valuations ({quarterLabel(q)}) · shared by every client’s review</h2>
        <fieldset disabled={dis} className="grid gap-2">
          {Array.from({ length: 6 }, (_, i) => {
            const row = ctx.market.rows[i];
            return (
              <div key={i} className="grid grid-cols-[2fr_1fr_1fr] gap-2">
                <Input name={`m.${i}.index`} defaultValue={row?.index ?? ""} placeholder={["Nifty 50", "Nifty Midcap 150", "Nifty Smallcap 250", "Nifty Bank", "", ""][i] || "Index"} aria-label={`Index ${i + 1}`} />
                <Input name={`m.${i}.pe`} inputMode="decimal" defaultValue={row?.peNow ?? ""} placeholder="P/E now" aria-label={`P/E now ${i + 1}`} />
                <Input name={`m.${i}.median`} inputMode="decimal" defaultValue={row?.median ?? ""} placeholder="5Y median" aria-label={`5-year median ${i + 1}`} />
              </div>
            );
          })}
          <div className="grid gap-2 md:grid-cols-[1fr_3fr]">
            <Field label="P/E as of"><Input name="m.asOf" defaultValue={ctx.market.asOf ?? ""} placeholder="9 Oct 2026" /></Field>
            <Field label="What it means (default note for every client)"><Input name="m.note" defaultValue={ctx.market.note ?? ""} maxLength={600} /></Field>
          </div>
          {canEdit ? <div className="flex justify-end"><SubmitButton variant="outline">Save valuations</SubmitButton></div> : null}
        </fieldset>
      </ActionForm>
    </div>
  );
}
