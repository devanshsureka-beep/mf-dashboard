"use client";

import "@fontsource/lato/400.css";
import "@fontsource/lato/700.css";
import "@fontsource/source-serif-4/400.css";
import "@fontsource/source-serif-4/600.css";
import "@fontsource/source-serif-4/700.css";
import "@fontsource/source-serif-4/400-italic.css";
import "./review.css";
import { createContext, useContext, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { croreWhen, type QuarterlyReport } from "@/lib/domain/quarterly-report";
import { date, L, pageHeads, pct, R, RIA, share, signed } from "@/lib/domain/quarterly-format";
import { DEFAULT_RATES, PROJECTION_YEARS } from "@/lib/domain/quarterly";
import { FUND_STATUSES, setInput, type MarketContext, type QuarterlyInputs } from "@/lib/domain/quarterly-inputs";
import type { ActionResult } from "@/lib/actions";
import { safeAction } from "@/lib/safe-action";

/**
 * The quarterly review as it prints: the same pages, order and wording as the PDF (after the
 * reference report). "Edit" turns every block the advisor writes into text typed in place; numbers
 * stay automatic. Clearing a block brings back the automatic text.
 */

type Path = readonly (string | number)[];
type Inputs = QuarterlyInputs;
export interface SavePayload { inputs: Inputs; market: MarketContext | null; index: Record<string, string> }

const C = { navy: "#0d1f3c", navy2: "#1e3a63", gold: "#b8932f", goldSoft: "#e5c76b", ink: "#1c2533", muted: "#6b7385", green: "#2f6d4a", red: "#a23b2c", amber: "#b57a1e", steel: "#8e9aad", blue: "#3e6587", blue2: "#8fb0c8", pale: "#c9ced8" };
const up = (x: number | null | undefined) => (x == null ? C.ink : x >= 0 ? C.green : C.red);
const PILL: Record<string, string> = {
  DONE: C.green, GREEN: C.green, RUNNING: C.green, OPEN: C.green, CHEAP: C.green, FAIR: C.green,
  PARTLY: C.amber, AMBER: C.amber, STRETCHED: C.amber, PAUSED: C.amber,
  CONFIRM: C.navy2, CHANGE: C.navy2, START: C.navy2, "NOT DONE": C.red, RED: C.red, EXIT: C.red, STOP: C.red,
};
const Pill = ({ label }: { label: string }) => <span className="qr-pill" style={{ color: PILL[label] ?? C.muted }}>{label}</span>;

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

interface EditCtx { editing: boolean; draft: Inputs; saved: Inputs; set: (path: Path, value: unknown) => void }
const Edit = createContext<EditCtx>({ editing: false, draft: {}, saved: {}, set: () => {} });


/** Text the advisor writes. Shows `value`; when edited, keeps the text unless it is the automatic one (or empty). */
function Ed({ path, value, gen, block, className, style, placeholder, onText }: {
  path?: Path; value: string; gen: string; block?: boolean; className?: string; style?: React.CSSProperties; placeholder?: string;
  onText?: (text: string) => void;
}) {
  const { editing, set } = useContext(Edit);
  const Tag = block ? "div" : "span";
  return (
    <Tag
      key={`${editing ? "e" : "v"}|${value}`}
      className={`qr-ed${block ? " block" : ""}${className ? ` ${className}` : ""}`}
      style={style}
      contentEditable={editing}
      suppressContentEditableWarning
      data-placeholder={placeholder ?? "Write here (empty keeps the automatic text)"}
      onBlur={(e) => {
        const text = (e.currentTarget.innerText ?? "").replace(/ /g, " ").replace(/\n{3,}/g, "\n\n").trim();
        if (onText) return onText(text);
        if (path) set(path, text && text !== gen.trim() ? text : undefined);
      }}
    >
      {value}
    </Tag>
  );
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function Frame({ r, page, children }: { r: QuarterlyReport; page: string; children: ReactNode }) {
  const heads = pageHeads(r);
  const i = heads.findIndex((p) => p.key === page);
  const h = heads[i];
  return (
    <section className="qr-page" aria-label={h.section}>
      <div className="qr-head"><div className="qr-brand">UNIVEST <b>WEALTH</b></div><div className="qr-section">{h.section}</div></div>
      <div className="qr-eyebrow">{h.eyebrow}</div>
      <h2 className="qr-title">{h.title}</h2>
      {children}
      <div className="qr-foot"><span>Univest Wealth Quarterly Review — {r.client.name} — Page {i + 1}</span><span>{RIA} · Private &amp; confidential</span></div>
    </section>
  );
}

function Kpis({ items }: { items: { label: string; value: ReactNode; sub?: ReactNode; color?: string }[] }) {
  return (
    <div className="qr-kpis">
      {items.map((k) => <div key={k.label}><small>{k.label}</small><strong style={k.color ? { color: k.color } : undefined}>{k.value}</strong>{k.sub ? <span>{k.sub}</span> : null}</div>)}
    </div>
  );
}

function Bars({ items }: { items: { label: string; value: number; color: string }[] }) {
  const lo = Math.min(0, ...items.map((i) => i.value));
  const hi = Math.max(0, ...items.map((i) => i.value));
  const span = hi - lo || 1;
  const pos = (v: number) => 12 + ((v - lo) / span) * 76;
  return (
    <div className="qr-bars">
      {items.map((it) => {
        const a = Math.min(pos(0), pos(it.value));
        const w = Math.max(0.5, Math.abs(pos(it.value) - pos(0)));
        return (
          <div key={it.label} className="qr-bar">
            <span>{it.label}</span>
            <div className="track">
              <div className="zero" style={{ left: `${pos(0)}%` }} />
              <div className="fill" style={{ left: `${a}%`, width: `${w}%`, background: it.color }} />
              <div className="val" style={it.value >= 0 ? { left: `calc(${a + w}% + 5px)` } : { right: `calc(${100 - a}% + 5px)` }}>{pct(it.value)}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Donut({ parts, label }: { parts: { value: number; color: string }[]; label: string }) {
  const total = parts.reduce((t, p) => t + p.value, 0) || 1;
  const shown = parts.filter((p) => p.value > 0);
  const ends = shown.map((_, i) => (shown.slice(0, i + 1).reduce((t, p) => t + p.value, 0) / total) * Math.PI * 2);
  const pt = (a: number) => `${88 + 66 * Math.sin(a)} ${88 - 66 * Math.cos(a)}`;
  return (
    <svg width={176} height={176} viewBox="0 0 176 176" role="img" aria-label={label}>
      {shown.map((p, i) => {
        const a0 = i ? ends[i - 1] : 0;
        const a1 = Math.min(ends[i], a0 + Math.PI * 2 - 0.0001);
        return <path key={i} d={`M ${pt(a0)} A 66 66 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${pt(a1)}`} stroke={p.color} strokeWidth={29} fill="none" />;
      })}
      <text x="88" y="92" textAnchor="middle" fontFamily="Source Serif 4, Georgia, serif" fontSize="11.5" fill={C.ink}>{label}</text>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function Cover({ r, g }: { r: QuarterlyReport; g: QuarterlyReport }) {
  const m = r.money;
  const sipFunds = r.sip.rows.filter((x) => x.amount > 0).length;
  return (
    <section className="qr-page cover" aria-label="Cover">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div className="qr-brand" style={{ color: "#fff", fontSize: 18.7 }}>UNIVEST <b>WEALTH</b></div>
        <div style={{ fontSize: 10, letterSpacing: 1.9, color: C.gold }}>{RIA}</div>
      </div>
      <div style={{ marginTop: 122 }}>
        <div style={{ fontSize: 10.7, letterSpacing: 2.9, color: C.gold, fontWeight: 700, marginBottom: 16 }}>QUARTERLY PORTFOLIO REVIEW · UPDATED TO {date(r.asOf).toUpperCase()}</div>
        <div style={{ fontFamily: "var(--serif)", fontSize: 53, marginBottom: 18, lineHeight: 1.1 }}>{r.client.name}</div>
        <Ed path={["tagline"]} value={r.texts.tagline} gen={g.texts.tagline} block style={{ fontFamily: "var(--serif)", fontStyle: "italic", fontSize: 18, color: "#e3dcc6", marginBottom: 21 }} />
        <div style={{ fontSize: 10.1, color: "#c3ccdb" }}>
          Review {r.reviewNo} · {r.quarterLabel} · Review period {date(r.windowStart)} – {date(r.windowEnd)} · CAS of {date(r.casDate)}, units revalued at AMFI NAV of {date(r.asOf)} · Prepared {date(r.prepared)}
        </div>
      </div>
      <div style={{ position: "absolute", left: 85, right: 85, bottom: 72 }}>
        <Kpis items={[
          { label: "Portfolio value", value: L(r.totals.value), sub: `${date(r.asOf)} · ${r.totals.funds} fund${r.totals.funds === 1 ? "" : "s"}` },
          { label: `Nifty 50 since ${date(r.windowStart, false)}`, value: pct(m.niftySinceStart), sub: `${date(r.windowStart, false)} – ${date(r.asOf, false)}` },
          { label: "Your new money", value: pct(m.ret), color: C.goldSoft, sub: m.aheadOfNifty != null ? `${R(Math.abs(m.aheadOfNifty))} ${m.aheadOfNifty >= 0 ? "ahead of" : "behind"} Nifty 50` : m.deployed ? `on ${L(m.deployed)} put in` : "no new money this quarter" },
          { label: "Monthly SIP from next month", value: r.sip.fromNext ? R(r.sip.fromNext) : "—", color: C.goldSoft, sub: `${sipFunds} fund${sipFunds === 1 ? "" : "s"}` },
        ]} />
      </div>
    </section>
  );
}

function Glance({ r, g }: { r: QuarterlyReport; g: QuarterlyReport }) {
  const t = r.totals;
  const m = r.money;
  const bars = [
    m.niftyRet != null ? { label: "Same cash in Nifty 50", value: m.niftyRet, color: C.steel } : null,
    m.ret != null ? { label: "Your new funds (actual)", value: m.ret, color: C.gold } : null,
  ].filter((b): b is { label: string; value: number; color: string } => b !== null);
  return (
    <Frame r={r} page="glance">
      <Kpis items={[
        { label: "Total invested (cost)", value: L(t.cost), sub: "current holdings" },
        { label: `Value on ${date(r.asOf, false)}`, value: L(t.value), sub: `${L(t.casValue)} at your ${date(r.casDate, false)} CAS` },
        { label: "Gain on cost", value: signed(t.gain), color: up(t.gain), sub: `${pct(t.gainPct)} absolute${t.xirr != null ? ` · XIRR ${pct(t.xirr)}` : ""}` },
        r.casDate < r.asOf
          ? { label: "Since your CAS", value: signed(t.sinceCas), color: up(t.sinceCas), sub: `${pct(t.sinceCasPct)} · ${date(r.casDate, false)} – ${date(r.asOf, false)}` }
          : { label: "Funds held", value: String(t.funds), sub: `as of your ${date(r.casDate, false)} CAS` },
      ]} />
      <div className="qr-row">
        <div>
          <h3 className="qr-h3">The review in one line</h3>
          <Ed path={["headline"]} value={r.texts.headline} gen={g.texts.headline} block style={{ fontFamily: "var(--serif)", fontSize: 16.7, lineHeight: 1.45, color: C.navy, marginBottom: 12 }} />
          <Ed path={["glance"]} value={r.texts.glance.join("\n\n")} gen={g.texts.glance.join("\n\n")} block className="qr-body" />
        </div>
        <div>
          <h3 className="qr-h3">New money: same rupees, same dates</h3>
          {bars.length ? <Bars items={bars} /> : <p className="qr-small">No new money went in during this review period.</p>}
          <p className="qr-small" style={{ marginTop: 8 }}>
            {m.deployed ? `Return on ${R(m.deployed)} put in ${date(r.windowStart, false)} – ${date(r.windowEnd, false)}, valued at ${date(r.asOf)} NAVs. ` : ""}
            {t.years < 1 ? "Under a year of history is too short to annualise; all figures are absolute. " : ""}
            {m.indexAsOf ? `The Nifty 50 comparison uses Direct-plan index-fund NAVs to ${date(m.indexAsOf)}.` : ""}
          </p>
        </div>
      </div>
    </Frame>
  );
}

function Story({ r, g }: { r: QuarterlyReport; g: QuarterlyReport }) {
  const { draft, set } = useContext(Edit);
  const m = r.money;
  const card = (i: number, field: "when" | "title" | "text", text: string) => {
    const cur = { ...(draft.story?.[i]?.title || draft.story?.[i]?.text ? draft.story![i] : r.story[i]) };
    const next = { ...cur, [field]: text || g.story[i][field] };
    const same = next.when === g.story[i].when && next.title === g.story[i].title && next.text === g.story[i].text;
    const slots = Array.from({ length: Math.max(5, draft.story?.length ?? 0) }, (_, k) => draft.story?.[k] ?? { when: "", title: "", text: "" });
    slots[i] = same ? { when: "", title: "", text: "" } : next;
    set(["story"], slots.some((s) => s.title || s.text) ? slots : undefined);
  };
  return (
    <Frame r={r} page="story">
      <div className="qr-cards">
        {r.story.map((c, i) => (
          <div key={i}>
            <Ed value={c.when} gen={g.story[i].when} block className="when" onText={(t) => card(i, "when", t)} />
            <Ed value={c.title} gen={g.story[i].title} block className="t" onText={(t) => card(i, "title", t)} />
            <Ed value={c.text} gen={g.story[i].text} block className="x" onText={(t) => card(i, "text", t)} />
          </div>
        ))}
      </div>
      <Kpis items={[
        { label: "Recycled from old funds", value: L(Math.min(m.recycled, m.deployed || m.recycled)), sub: "sales in this period" },
        { label: "Fresh money added", value: L(m.fresh), sub: "beyond the sale proceeds" },
        { label: "Added by the switch", value: r.old ? signed(r.old.added, false) : "—", color: r.old ? up(r.old.added) : undefined, sub: r.old ? "vs keeping the old funds" : "no exits this period" },
        { label: "Ahead of Nifty 50", value: m.aheadOfNifty != null ? signed(m.aheadOfNifty) : "—", color: up(m.aheadOfNifty), sub: "same rupees, same dates" },
      ]} />
      <div className={r.texts.storySentence ? "qr-call" : "qr-call qr-only-edit"}>
        <b>In one sentence: </b><Ed path={["storySentence"]} value={r.texts.storySentence} gen="" placeholder="Optional: one sentence on the whole period" />
      </div>
    </Frame>
  );
}

function Market({ r, g, market, setMarket }: { r: QuarterlyReport; g: QuarterlyReport; market: MarketContext; setMarket: (m: MarketContext) => void }) {
  const mk = r.market;
  const rows = [...market.rows, ...Array.from({ length: Math.max(0, 4 - market.rows.length) }, () => ({ index: "", peNow: 0, median: 0 }))];
  const change = (i: number, k: "index" | "peNow" | "median", v: string) => {
    const next = rows.map((row, j) => (j === i ? { ...row, [k]: k === "index" ? v : Number(v) || 0 } : row));
    setMarket({ ...market, rows: next });
  };
  return (
    <Frame r={r} page="market">
      <div className="qr-row">
        <div>
          <h3 className="qr-h3">Index moves over your review window</h3>
          {mk.moves.length ? <Bars items={mk.moves.map((x, i) => ({ label: x.label, value: x.pct, color: i < 2 ? (x.pct < 0 ? C.navy2 : C.blue) : C.blue2 }))} /> : <p className="qr-small">Index history is not available yet.</p>}
          <p className="qr-small" style={{ marginTop: 8 }}>Moves of Direct-plan index funds tracking each index{r.money.indexAsOf ? `, to ${date(r.money.indexAsOf)}` : ""}.</p>
        </div>
        <div>
          <h3 className="qr-h3">Valuations vs their 5-year median</h3>
          <table className="qr-table qr-only-view">
            <thead><tr><th>Index</th><th className="n">P/E now</th><th className="n">5Y median</th><th className="n">Gap</th><th className="c">Read</th></tr></thead>
            <tbody>
              {mk.valuations.length ? mk.valuations.map((v) => (
                <tr key={v.index}><td>{v.index}</td><td className="n">{v.peNow.toFixed(1)}</td><td className="n">{v.median.toFixed(1)}</td><td className="n">{pct(v.gap, 0)}</td><td className="c"><Pill label={v.read} /></td></tr>
              )) : <tr><td colSpan={5} className="m">Not entered yet for this quarter: press Edit to add them.</td></tr>}
            </tbody>
          </table>
          <table className="qr-table qr-only-edit">
            <thead><tr><th>Index</th><th className="n">P/E now</th><th className="n">5Y median</th></tr></thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  <td><input className="qr-in" value={row.index} placeholder={["Nifty 50", "Nifty Midcap 150", "Nifty Smallcap 250", "Nifty Bank"][i] ?? "Index"} onChange={(e) => change(i, "index", e.target.value)} aria-label={`Index ${i + 1}`} /></td>
                  <td><input className="qr-in" inputMode="decimal" value={row.peNow || ""} onChange={(e) => change(i, "peNow", e.target.value)} aria-label={`P/E now ${i + 1}`} /></td>
                  <td><input className="qr-in" inputMode="decimal" value={row.median || ""} onChange={(e) => change(i, "median", e.target.value)} aria-label={`5-year median ${i + 1}`} /></td>
                </tr>
              ))}
              <tr><td colSpan={3}><button type="button" className="qr-mini" onClick={() => setMarket({ ...market, rows: [...rows, { index: "", peNow: 0, median: 0 }] })}>+ Add index</button> <span className="qr-small">Shared by every client’s review this quarter.</span></td></tr>
            </tbody>
          </table>
          <p className="qr-small" style={{ marginTop: 6 }}>P/E as of <span className="qr-only-view">{mk.asOf ?? "—"}</span><input className="qr-in qr-only-edit" style={{ width: 120 }} value={market.asOf ?? ""} placeholder="9 Oct 2026" onChange={(e) => setMarket({ ...market, asOf: e.target.value })} />.</p>
          <div className="qr-call" style={{ marginTop: 14 }}>
            <b>What it means for you. </b><Ed path={["marketNote"]} value={r.texts.marketNote} gen={g.texts.marketNote} placeholder="What the valuations mean for this client's buying" />
          </div>
        </div>
      </div>
    </Frame>
  );
}

function Plan({ r, g }: { r: QuarterlyReport; g: QuarterlyReport }) {
  return (
    <Frame r={r} page="plan">
      <table className="qr-table">
        <thead><tr><th style={{ width: "30%" }}>What happened</th><th>Detail</th><th className="c" style={{ width: 90 }}>Status</th></tr></thead>
        <tbody>{r.plan.rows.map((x, i) => <tr key={i}><td className="b">{x.what}</td><td>{x.detail}</td><td className="c"><Pill label={x.status} /></td></tr>)}</tbody>
      </table>
      <div className="qr-call" style={{ marginTop: 18 }}>
        <b>Execution: {r.plan.done} of {r.plan.total} plan lines done. </b><Ed path={["planCallout"]} value={r.texts.planCallout} gen={g.texts.planCallout} />
      </div>
    </Frame>
  );
}

function Scorecard({ r, g }: { r: QuarterlyReport; g: QuarterlyReport }) {
  const sc = r.score;
  return (
    <Frame r={r} page="score">
      <table className="qr-table">
        <thead><tr><th>Fund</th><th className="n">New money in</th><th className="n">Worth on {date(r.asOf, false)}</th><th className="n">Return</th><th className="n">Own index</th><th className="n">Ahead / behind index</th></tr></thead>
        <tbody>{sc.rows.map((x) => (
          <tr key={x.key}><td className="b">{x.name}</td><td className="n">{R(x.newIn)}</td><td className="n">{R(x.worth)}</td><td className="n b" style={{ color: up(x.ret) }}>{pct(x.ret)}</td><td className="n">{x.index ?? "—"}</td><td className="n b" style={{ color: x.ahead == null ? undefined : up(x.ahead) }}>{x.ahead == null ? "—" : signed(x.ahead)}</td></tr>
        ))}</tbody>
        <tfoot><tr><td>All new money</td><td className="n">{R(sc.total.newIn)}</td><td className="n">{R(sc.total.worth)}</td><td className="n">{pct(sc.total.ret)}</td><td /><td /></tr></tfoot>
      </table>
      <div className="qr-row" style={{ marginTop: 16, gap: 19 }}>
        <div className={r.texts.winnersNote ? "qr-call green" : "qr-call green qr-only-edit"}><Ed path={["winnersNote"]} value={r.texts.winnersNote} gen={g.texts.winnersNote} placeholder="Funds ahead of their index" /></div>
        <div className={r.texts.laggardNote ? "qr-call amber" : "qr-call amber qr-only-edit"}><Ed path={["laggardNote"]} value={r.texts.laggardNote} gen={g.texts.laggardNote} placeholder="Funds behind their index" /></div>
      </div>
      <p className="qr-small" style={{ marginTop: 10 }}>Values use {date(r.asOf)} NAVs on your units. Each purchase is replayed into a Direct-plan index fund on the same date{r.money.indexAsOf ? `, valued to ${date(r.money.indexAsOf)}` : ""}. Funds without a fitting index show “—”.</p>
    </Frame>
  );
}

function OldNew({ r, g }: { r: QuarterlyReport; g: QuarterlyReport }) {
  const o = r.old!;
  return (
    <Frame r={r} page="old">
      <div className="qr-row">
        <div style={{ flex: 1.1 }}>
          <h3 className="qr-h3">The money we moved: {L(o.soldFor)}</h3>
          <table className="qr-table">
            <thead><tr><th>Old fund</th><th className="n">Sold for</th><th className="n">Worth today if kept</th><th className="n">Return</th></tr></thead>
            <tbody>{o.rows.map((x) => <tr key={x.name}><td><b>{x.name}</b><div className="qr-small">{x.units.toFixed(0)} units sold</div></td><td className="n">{R(x.soldFor)}</td><td className="n">{R(x.worthIfKept)}</td><td className="n">{pct(x.ret)}</td></tr>)}</tbody>
            <tfoot><tr><td>Old funds</td><td className="n">{R(o.soldFor)}</td><td className="n">{R(o.worthIfKept)}</td><td className="n">{pct(o.oldRet)}</td></tr></tfoot>
          </table>
          <table className="qr-table" style={{ marginTop: 13 }}>
            <thead><tr><th>Where the money went</th><th className="n">Put in</th><th className="n">Worth today</th><th className="n">Return</th></tr></thead>
            <tbody>{o.newRows.map((x) => <tr key={x.name}><td className="b">{x.name}</td><td className="n">{R(x.putIn)}</td><td className="n">{R(x.worth)}</td><td className="n">{pct(x.ret)}</td></tr>)}</tbody>
          </table>
          <p className="qr-small" style={{ marginTop: 8 }}>Old funds are valued at {date(r.asOf)} NAVs on the units sold (dividends they would have paid are not added). The new-money return is applied to the sale proceeds.</p>
        </div>
        <div>
          <h3 className="qr-h3">Old portfolio vs new portfolio</h3>
          <Bars items={[{ label: "Kept the old funds", value: o.oldRet, color: C.steel }, { label: "Moved to the new funds", value: o.newRet, color: C.gold }]} />
          <div style={{ height: 10 }} />
          <Kpis items={[
            { label: "Additional value created", value: signed(o.added), color: up(o.added), sub: "on the money we moved" },
            { label: "Book today", value: L(r.totals.value), sub: "new portfolio" },
            { label: "Book if nothing moved", value: L(o.bookIfKept), color: C.steel, sub: "old funds kept" },
          ]} />
          <div className={`qr-call ${o.added >= -500 ? "green" : "amber"}`}><Ed path={["oldVsNewNote"]} value={r.texts.oldVsNewNote} gen={g.texts.oldVsNewNote} /></div>
        </div>
      </div>
    </Frame>
  );
}

function Health({ r, g, benchmarks, index, setIndex }: { r: QuarterlyReport; g: QuarterlyReport; benchmarks: { code: string; name: string }[]; index: Record<string, string>; setIndex: (isin: string, code: string) => void }) {
  const { draft, set } = useContext(Edit);
  const sinceCas = r.casDate < r.asOf;
  const benchName = (code: string | null) => benchmarks.find((b) => b.code === code)?.name ?? "No index";
  return (
    <Frame r={r} page="health">
      <table className="qr-table">
        <thead><tr>
          <th>Fund</th><th className="n">Value {date(r.asOf, false)}</th><th className="n">Weight</th><th className="n">On cost</th>
          {sinceCas ? <th className="n">{date(r.casDate, false)} – {date(r.asOf, false)}</th> : null}
          <th className="c">Status</th><th style={{ width: "34%" }}>Why</th><th className="qr-only-edit">Compared with</th>
        </tr></thead>
        <tbody>{r.health.map((x) => {
          const gen = g.health.find((h) => h.key === x.key);
          const status = draft.funds?.[x.key]?.status ?? "";
          const was = x.indexIsDefault ? "" : x.index ?? "NONE";
          return (
            <tr key={x.key}>
              <td className="b">{x.name}</td><td className="n">{R(x.value)}</td><td className="n">{share(x.weight)}</td><td className="n">{pct(x.onCost)}</td>
              {sinceCas ? <td className="n">{pct(x.sinceCas)}</td> : null}
              <td className="c">
                <span className="qr-only-view">{x.status ? <Pill label={x.status} /> : "—"}</span>
                <select className="qr-sel qr-only-edit" value={status} onChange={(e) => set(["funds", x.key, "status"], e.target.value || undefined)} aria-label={`Status of ${x.name}`}>
                  <option value="">{gen?.status ? `${gen.status} (auto)` : "—"}</option>
                  {FUND_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </td>
              <td className="m"><Ed path={["funds", x.key, "why"]} value={x.why} gen={gen?.why ?? ""} placeholder="Why (shown in the PDF)" /></td>
              <td className="qr-only-edit">
                {x.isin ? (
                  <select className="qr-sel" value={index[x.isin] ?? was} onChange={(e) => setIndex(x.isin!, e.target.value)} aria-label={`Index for ${x.name}`}>
                    <option value="">Default{x.indexIsDefault ? ` (${benchName(x.index)})` : ""}</option>
                    {benchmarks.map((b) => <option key={b.code} value={b.code}>{b.name}</option>)}
                    <option value="NONE">No index</option>
                  </select>
                ) : <span className="qr-small">{benchName(x.index)}</span>}
              </td>
            </tr>
          );
        })}</tbody>
        <tfoot><tr><td>Portfolio</td><td className="n">{R(r.totals.value)}</td><td className="n">100%</td><td className="n">{pct(r.totals.gainPct)}</td>{sinceCas ? <td className="n">{pct(r.totals.sinceCasPct)}</td> : null}<td /><td /><td className="qr-only-edit" /></tr></tfoot>
      </table>
      <p className="qr-small" style={{ marginTop: 8 }}>Return on cost is absolute. Cost is the CAS cost, or worked out from your transactions when the CAS gives none.</p>
    </Frame>
  );
}

function Rebalance({ r, g }: { r: QuarterlyReport; g: QuarterlyReport }) {
  const { draft, set } = useContext(Edit);
  const rb = r.rebalance!;
  return (
    <Frame r={r} page="rebalance">
      <Kpis items={[
        { label: "Redeemed", value: rb.redeemed ? R(rb.redeemed) : "—", sub: `${rb.sells.length} line${rb.sells.length === 1 ? "" : "s"}` },
        { label: "Reinvested", value: rb.reinvested ? R(rb.reinvested) : "—", sub: `${rb.buys.length} fund${rb.buys.length === 1 ? "" : "s"} · Direct plans` },
        ...(rb.topAmc ? [{ label: `${rb.topAmc.name} weight`, value: share(rb.topAmc.after), color: C.gold, sub: `from ${share(rb.topAmc.now)} now` }] : []),
      ]} />
      <div className="qr-row">
        {rb.sells.length ? (
          <div>
            <h3 className="qr-h3">What we sell</h3>
            <table className="qr-table">
              <thead><tr><th>Redeem</th><th className="n">Units</th><th className="n">Value at {date(r.asOf, false)} NAV</th><th className="n">Gain vs cost</th></tr></thead>
              <tbody>{rb.sells.map((x) => <tr key={x.key}><td className="b">{x.name}</td><td className="n">{x.units == null ? "—" : x.units.toFixed(3)}</td><td className="n">{R(x.value)}</td><td className="n">{x.gain == null ? "—" : R(x.gain)}</td></tr>)}</tbody>
              <tfoot><tr><td>Total redemption</td><td /><td className="n">{R(rb.redeemed)}</td><td className="n">{R(rb.sells.reduce((t, x) => t + (x.gain ?? 0), 0))}</td></tr></tfoot>
            </table>
            <p className="qr-small" style={{ marginTop: 6 }}>Amounts at {date(r.asOf)} NAV; the final figure is set by the NAV on the redemption date.</p>
          </div>
        ) : null}
        {rb.buys.length ? (
          <div style={{ flex: 1.2 }}>
            <h3 className="qr-h3">What we buy</h3>
            <table className="qr-table">
              <thead><tr><th>Buy</th><th className="n">Amount</th><th>Funded by</th><th className="c">Lumpsum</th><th className="c">SIP</th><th>Why</th></tr></thead>
              <tbody>{rb.buys.map((x) => {
                const gen = g.rebalance?.buys.find((b) => b.key === x.key);
                const sel = (kind: "lumpsum" | "sipOpen", val: string) => (
                  <>
                    <span className="qr-only-view"><Pill label={val} /></span>
                    <select className="qr-sel qr-only-edit" value={draft[kind]?.[x.key] ?? ""} onChange={(e) => set([kind, x.key], e.target.value || undefined)} aria-label={`${kind === "lumpsum" ? "Lumpsum" : "SIP"} for ${x.name}`}>
                      <option value="">{kind === "lumpsum" ? "Confirm" : "OPEN"}</option><option value="OPEN">OPEN</option><option value="PAUSED">PAUSED</option>
                    </select>
                  </>
                );
                return (
                  <tr key={x.key}>
                    <td className="b">{x.name}</td><td className="n">{R(x.amount)}</td><td>{x.fundedBy}</td>
                    <td className="c">{sel("lumpsum", x.lumpsum)}</td><td className="c">{sel("sipOpen", x.sip)}</td>
                    <td className="m"><Ed path={["buyWhy", x.key]} value={x.why} gen={gen?.why ?? ""} placeholder="Why" /></td>
                  </tr>
                );
              })}</tbody>
              <tfoot><tr><td>Total buy</td><td className="n">{R(rb.reinvested)}</td><td colSpan={4} /></tr></tfoot>
            </table>
            <p className="qr-small" style={{ marginTop: 6 }}>Lumpsum and SIP status as of this review; confirm on the order screen. <Ed path={["rebalanceNote"]} value={r.texts.rebalanceNote} gen="" placeholder="Optional note" /></p>
          </div>
        ) : null}
      </div>
    </Frame>
  );
}

const CAP_COLORS: Record<string, string> = { "Large cap": C.navy, "Large & mid": C.navy2, "Mid cap": C.blue, "Small cap": C.blue2, "Flexi / multi": "#a9b7c9", Sectoral: C.gold, Other: C.pale };

function Structure({ r, g }: { r: QuarterlyReport; g: QuarterlyReport }) {
  const st = r.structure;
  const hasBefore = st.rows.some((x) => x.before != null);
  return (
    <Frame r={r} page="structure">
      <div className="qr-row">
        <div style={{ flex: 1.2 }}>
          <div style={{ display: "flex", justifyContent: "space-around" }}>
            <Donut label={`Now · ${date(r.asOf, false)}`} parts={st.rows.map((x) => ({ value: x.now, color: CAP_COLORS[x.label] }))} />
            {st.changes ? <Donut label="After rebalance" parts={st.rows.map((x) => ({ value: x.after, color: CAP_COLORS[x.label] }))} /> : null}
          </div>
          <div className="qr-legend">{st.rows.map((x) => <span key={x.label}><i style={{ background: CAP_COLORS[x.label] }} />{x.label}</span>)}</div>
          <p className="qr-small" style={{ marginTop: 10 }}>By each fund’s category. Flexi, multi, focused, value and ELSS funds hold large, mid and small companies together and are shown as one group.</p>
        </div>
        <div>
          <table className="qr-table">
            <thead><tr><th>Segment</th>{hasBefore ? <th className="n">At onboarding</th> : null}<th className="n">Now</th>{st.changes ? <th className="n">After</th> : null}</tr></thead>
            <tbody>{st.rows.map((x) => <tr key={x.label}><td>{x.label}</td>{hasBefore ? <td className="n">{share(x.before)}</td> : null}<td className="n">{share(x.now)}</td>{st.changes ? <td className="n">{share(x.after)}</td> : null}</tr>)}</tbody>
          </table>
          <table className="qr-table" style={{ marginTop: 13 }}>
            <thead><tr><th>Fund house</th><th className="n">Now</th>{st.changes ? <th className="n">After</th> : null}<th className="c">Limit 35%</th></tr></thead>
            <tbody>{st.amc.map((x) => <tr key={x.name}><td>{x.name}</td><td className="n">{share(x.now)}</td>{st.changes ? <td className="n">{share(x.after)}</td> : null}<td className="c">{x.name === "Other" ? "—" : <Pill label={Math.max(x.now, st.changes ? x.after : 0) > 0.35 ? "RED" : "GREEN"} />}</td></tr>)}</tbody>
          </table>
          <h3 className="qr-h3" style={{ marginTop: 16 }}>What changes</h3>
          <Ed path={["structureNote"]} value={r.texts.structureNote} gen={g.texts.structureNote} block className="qr-body" />
        </div>
      </div>
    </Frame>
  );
}

function Sip({ r, g }: { r: QuarterlyReport; g: QuarterlyReport }) {
  const sp = r.sip;
  const funds = sp.rows.filter((x) => x.amount > 0).length;
  return (
    <Frame r={r} page="sip">
      <Kpis items={[
        { label: "Last quarter (average)", value: sp.lastQuarter ? `~${R(Math.round(sp.lastQuarter / 100) * 100)}` : "—", sub: "per month, from your CAS" },
        { label: "From next month", value: sp.fromNext ? R(sp.fromNext) : "—", color: C.gold, sub: `${funds} fund${funds === 1 ? "" : "s"}` },
        { label: "No new money", value: `${sp.noNewMoney.length} fund${sp.noNewMoney.length === 1 ? "" : "s"}`, sub: <Ed path={["noNewMoney"]} value={sp.noNewMoney.join(", ")} gen={g.sip.noNewMoney.join(", ")} placeholder="Funds held as they are, comma separated" /> },
      ]} />
      <table className="qr-table">
        <thead><tr><th>Fund</th><th className="n">Monthly SIP</th><th className="c">Status</th><th style={{ width: "40%" }}>Why</th></tr></thead>
        <tbody>{sp.rows.map((x) => (
          <tr key={x.id}>
            <td><b>{x.name}</b> <span className="qr-small">{x.category}</span></td><td className="n">{x.amount ? R(x.amount) : "Stop"}</td><td className="c"><Pill label={x.action} /></td>
            <td className="m"><Ed path={["sipWhy", x.id]} value={x.why} gen={g.sip.rows.find((s) => s.id === x.id)?.why ?? ""} placeholder="Why" /></td>
          </tr>
        ))}</tbody>
        <tfoot><tr><td>Monthly SIP</td><td className="n">{R(sp.fromNext)}</td><td /><td /></tr></tfoot>
      </table>
      <div className="qr-call" style={{ marginTop: 16 }}><Ed path={["sipNote"]} value={r.texts.sipNote} gen={g.texts.sipNote} /></div>
    </Frame>
  );
}

function Tax({ r, g }: { r: QuarterlyReport; g: QuarterlyReport }) {
  const { editing, draft, set } = useContext(Edit);
  const tx = r.tax;
  const notes = r.texts.taxNotes.slice(0, -1).join("\n\n");
  return (
    <Frame r={r} page="tax">
      <div className="qr-row">
        <div style={{ flex: 1.3 }}>
          {tx.lines.length ? (
            <table className="qr-table" style={{ marginBottom: 16 }}>
              <thead><tr><th>Line</th><th className="n">Value {date(r.asOf, false)}</th><th className="n">Cost</th><th className="n">Gain</th><th>Likely treatment</th></tr></thead>
              <tbody>{tx.lines.map((x) => <tr key={x.name}><td>{x.name}</td><td className="n">{R(x.value)}</td><td className="n">{x.cost == null ? "—" : R(x.cost)}</td><td className="n">{x.gain == null ? "—" : R(x.gain)}</td><td>{x.treatment}</td></tr>)}</tbody>
            </table>
          ) : null}
          <Kpis items={[
            ...(tx.lines.length ? [{ label: "Est. tax on rebalance", value: R(tx.estTax), color: tx.estTax < 1 && !tx.slabExcluded ? C.green : C.ink, sub: tx.slabExcluded ? "plus slab-rate tax on short-term / debt gains" : tx.estTax < 1 ? "within the exemption" : "12.5% LT above the limit, 20% ST" }] : []),
            { label: `${tx.fy} gains booked`, value: R(Math.max(0, tx.gains.equityLt) + Math.max(0, tx.gains.equitySt)), sub: `long-term ${L(Math.max(0, tx.gains.equityLt))} · short-term ${L(Math.max(0, tx.gains.equitySt))}` },
            { label: "₹1.25L limit left", value: R(tx.gains.exemptionLeft), color: C.green, sub: "tax-free long-term equity gains" },
            { label: "Est. exit load", value: <><span className="qr-only-view">{tx.exitLoad ? `~${R(tx.exitLoad)}` : "—"}</span><input key={String(editing)} className="qr-in qr-only-edit" style={{ width: 110, fontSize: 14 }} inputMode="decimal" defaultValue={draft.exitLoad ?? ""} placeholder="₹ (not in the CAS)" onBlur={(e) => set(["exitLoad"], e.target.value.trim() ? Number(e.target.value.replace(/[₹,\s]/g, "")) : undefined)} aria-label="Exit load" /></> },
          ]} />
          {tx.turningLong.length ? (
            <table className="qr-table">
              <thead><tr><th>Turns long-term on</th><th>Fund</th><th className="n">Value</th></tr></thead>
              <tbody>{tx.turningLong.map((x, i) => <tr key={i}><td>{date(x.date)}</td><td>{x.name}</td><td className="n">{R(x.value)}</td></tr>)}</tbody>
            </table>
          ) : null}
        </div>
        <div>
          <h3 className="qr-h3">Notes</h3>
          <Ed path={["taxNotes"]} value={notes} gen={g.texts.taxNotes.slice(0, -1).join("\n\n")} block className="qr-body" />
          <p className="qr-small" style={{ marginTop: 8 }}>{r.texts.taxNotes[r.texts.taxNotes.length - 1]}</p>
        </div>
      </div>
    </Frame>
  );
}

function Projections({ r }: { r: QuarterlyReport }) {
  const { editing, draft, set } = useContext(Edit);
  const p = r.projections;
  const W = 440, H = 266;
  const all = p.rows.flatMap((x) => x.values).concat(p.start).filter((v) => v > 0);
  const lo = Math.log10(Math.max(1, Math.min(...all) * 0.8));
  const hi = Math.log10(Math.max(...all) * 1.15);
  const X = (yr: number) => 60 + (yr / 20) * (W - 74);
  const Y = (v: number) => H - 24 - ((Math.log10(Math.max(1, v)) - lo) / (hi - lo || 1)) * (H - 40);
  const ticks = [1e5, 2.5e5, 5e5, 1e6, 2.5e6, 5e6, 1e7, 2.5e7, 5e7, 1e8, 2.5e8, 5e8, 1e9].filter((t) => Math.log10(t) >= lo && Math.log10(t) <= hi);
  const color: Record<string, string> = { invested: C.pale, bear: C.steel, nifty: C.blue, base: C.gold, moonshot: C.navy };
  const rate = (k: keyof typeof DEFAULT_RATES) => (
    <input key={`${k}-${editing}`} className="qr-in" style={{ width: 54 }} inputMode="decimal" defaultValue={draft.rates?.[k] ?? ""} placeholder={String(+(DEFAULT_RATES[k] * 100).toFixed(1))}
      onBlur={(e) => {
        const v = e.target.value.trim();
        const next = { ...(draft.rates ?? { bear: 6.5, nifty: 11, base: 14, moonshot: 18.7 }), [k]: v ? Number(v) : +(DEFAULT_RATES[k] * 100).toFixed(1) };
        const isDefault = (["bear", "nifty", "base", "moonshot"] as const).every((q) => Math.abs(next[q] - DEFAULT_RATES[q] * 100) < 1e-9);
        set(["rates"], isDefault ? undefined : next);
      }} aria-label={`${k} rate %`} />
  );
  return (
    <Frame r={r} page="projections">
      <div className="qr-row" style={{ gap: 37 }}>
        <div style={{ flex: "none", width: W }}>
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Projected value, log scale">
            {ticks.map((t) => <g key={t}><line x1={60} x2={W - 12} y1={Y(t)} y2={Y(t)} stroke="#e3e5ea" strokeWidth={0.7} /><text x={54} y={Y(t) + 3} textAnchor="end" fontSize="8.5" fill={C.muted}>{L(t).replace(".00", "")}</text></g>)}
            {PROJECTION_YEARS.map((yr) => <text key={yr} x={X(yr)} y={H - 6} textAnchor="middle" fontSize="8.5" fill={C.muted}>{yr}Y</text>)}
            {p.rows.map((row) => <polyline key={row.key} fill="none" stroke={color[row.key]} strokeWidth={row.key === "base" ? 2.6 : 1.6} strokeDasharray={row.key === "invested" ? "4 3" : undefined}
              points={[`${X(0)},${Y(p.start)}`, ...PROJECTION_YEARS.map((yr, i) => `${X(yr)},${Y(row.values[i])}`)].join(" ")} />)}
          </svg>
          <div className="qr-legend" style={{ justifyContent: "flex-start" }}>{p.rows.map((row) => <span key={row.key}><i style={{ background: color[row.key] }} />{row.label}</span>)}</div>
          <p className="qr-small qr-only-edit" style={{ marginTop: 10 }}>Rates (%): Bear {rate("bear")} Nifty 50 {rate("nifty")} Base {rate("base")} Moonshot {rate("moonshot")}</p>
        </div>
        <div>
          <table className="qr-table">
            <thead><tr><th>Scenario</th>{PROJECTION_YEARS.map((y) => <th key={y} className="n">{y}Y</th>)}</tr></thead>
            <tbody>{p.rows.map((row) => <tr key={row.key}><td>{row.label}</td>{row.values.map((v, i) => <td key={i} className="n">{L(v).replace(/(\.\d)0(?=L|Cr)/, "$1")}</td>)}</tr>)}</tbody>
          </table>
          <div className="qr-call" style={{ marginTop: 16 }}>
            {p.crossesCrore != null && p.crossesCrore > 0 ? <b>On the Base path the book crosses ₹1 Cr {croreWhen(p.crossesCrore)}. </b> : null}
            Starting point: {L(p.start)} on {date(r.asOf, false)}{p.sip ? ` plus the ${R(p.sip)} monthly SIP` : ""}. The Nifty 50 line shows the same money in a plain index fund.
          </div>
          <p className="qr-small" style={{ marginTop: 8 }}>Illustrations, not guarantees. Base {(p.rates.base * 100).toFixed(1).replace(/\.0$/, "")}% is our planning rate; Bear {(p.rates.bear * 100).toFixed(1).replace(/\.0$/, "")}% is roughly a fixed-deposit outcome; Moonshot reflects the chosen funds’ strongest 5-year stretch. Log scale.</p>
        </div>
      </div>
    </Frame>
  );
}

function Actions({ r, g }: { r: QuarterlyReport; g: QuarterlyReport }) {
  const { editing, draft, saved, set } = useContext(Edit);
  const own = (draft.actions ?? []).filter((a) => a.title || a.detail);
  // The automatic list: as printed now, unless that list is the advisor's own (then the plain one).
  const auto = saved.actions?.length ? g.actions : r.actions;
  const rows = editing ? (own.length ? own : auto) : r.actions;
  const write = (next: { title: string; detail: string; when: string }[]) => {
    const same = next.length === auto.length && next.every((a, i) => a.title === auto[i].title && a.detail === auto[i].detail && a.when === auto[i].when);
    set(["actions"], same || !next.some((a) => a.title || a.detail) ? undefined : next);
  };
  const edit = (i: number, k: "title" | "detail" | "when", text: string) => write(rows.map((a, j) => (j === i ? { ...a, [k]: text } : a)));
  return (
    <Frame r={r} page="actions">
      <table className="qr-table qr-actions">
        <thead><tr><th style={{ width: 32 }}>#</th><th>Action</th><th style={{ width: 150 }}>When</th><th className="qr-only-edit" style={{ width: 30 }} /></tr></thead>
        <tbody>{rows.map((a, i) => (
          <tr key={`${editing}-${own.length ? 1 : 0}-${i}-${rows.length}`}>
            <td className="num">{i + 1}</td>
            <td><Ed value={a.title} gen="" block className="b" onText={(t) => edit(i, "title", t)} placeholder="Action" /><Ed value={a.detail} gen="" block className="m" style={{ fontSize: 9.6, marginTop: 2 }} onText={(t) => edit(i, "detail", t)} placeholder="Detail" /></td>
            <td className="b"><Ed value={a.when} gen="" onText={(t) => edit(i, "when", t)} placeholder="When" /></td>
            <td className="qr-only-edit"><button type="button" className="qr-mini" onClick={() => write(rows.filter((_, j) => j !== i))} aria-label={`Remove action ${i + 1}`}>✕</button></td>
          </tr>
        ))}</tbody>
      </table>
      <div className="qr-only-edit" style={{ marginTop: 8 }}>
        {rows.length < 8 ? <button type="button" className="qr-mini" onClick={() => write([...rows, { title: "New action", detail: "", when: "This week" }])}>+ Add action</button> : null}
        {own.length ? <> <button type="button" className="qr-mini" onClick={() => set(["actions"], undefined)}>Back to the automatic list</button></> : null}
      </div>
      <div className="qr-next">
        <div><small>NEXT REVIEW</small><strong><Ed path={["nextReview"]} value={r.texts.nextReview} gen={g.texts.nextReview} /></strong></div>
        <p><Ed path={["nextReviewNote"]} value={r.texts.nextReviewNote} gen={g.texts.nextReviewNote} /></p>
      </div>
    </Frame>
  );
}

// ---------------------------------------------------------------------------

export function ReviewPages({ report: r, generated: g, inputs, market: savedMarket, benchmarks, canEdit, save }: {
  report: QuarterlyReport; generated: QuarterlyReport; inputs: Inputs; market: MarketContext; benchmarks: { code: string; name: string }[];
  canEdit: boolean; save: (payload: SavePayload) => Promise<ActionResult>;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Inputs>(inputs);
  const [market, setMarket] = useState<MarketContext>(savedMarket);
  const [index, setIndexState] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<ActionResult | null>(null);
  // After a save, stay in edit mode until the refreshed review arrives, so the pages never show the
  // old text and the next Edit starts from what was saved.
  const [awaiting, setAwaiting] = useState<QuarterlyReport | null>(null);
  if (awaiting && awaiting !== r) { setAwaiting(null); setEditing(false); }
  const [pending, start] = useTransition();
  const busy = pending || awaiting != null;
  // The ref always holds the latest draft, so Save sees the text whose blur it just caused.
  const latest = useRef<Inputs>(inputs);
  const ctx = useMemo<EditCtx>(() => ({
    editing, draft, saved: inputs,
    set: (path, value) => { latest.current = setInput(latest.current, path, value); setDraft(latest.current); },
  }), [editing, draft, inputs]);
  const heads = pageHeads(r).map((p) => p.key);
  const begin = () => { latest.current = inputs; setDraft(inputs); setMarket(savedMarket); setIndexState({}); setMessage(null); setEditing(true); };
  const cancel = () => { setEditing(false); latest.current = inputs; setDraft(inputs); setMarket(savedMarket); setIndexState({}); };
  const onSave = () => {
    // Let the field being typed in commit (its blur) before reading the draft.
    (document.activeElement as HTMLElement | null)?.blur?.();
    start(async () => {
      const marketChanged = JSON.stringify(market) !== JSON.stringify(savedMarket);
      const res = await safeAction(save)({ inputs: latest.current, market: marketChanged ? { ...market, rows: market.rows.filter((x) => x.index && x.peNow && x.median) } : null, index });
      setMessage(res);
      if (res.ok) { setAwaiting(r); router.refresh(); }
    });
  };
  return (
    <Edit.Provider value={ctx}>
      <div className={`qr${editing ? " editing" : ""}`}>
        <div className="qr-bar-tools">
          {message ? <span role={message.ok ? "status" : "alert"} className={message.ok ? "text-sm text-emerald-700" : "text-sm text-red-700"}>{message.ok ? message.message ?? "Saved." : message.error}</span> : null}
          {editing ? <span className="text-xs text-muted">Yellow blocks are yours to write; clearing one brings back the automatic text. Numbers stay automatic.</span> : null}
          <span className="flex-1" />
          {canEdit && !editing ? <button type="button" onClick={begin} className="rounded-md border border-border bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50">Edit</button> : null}
          {editing ? <>
            <button type="button" onClick={cancel} disabled={busy} className="rounded-md border border-border bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50">Cancel</button>
            <button type="button" onClick={onSave} disabled={busy} className="rounded-md bg-brand px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60">{busy ? "Saving…" : "Save"}</button>
          </> : null}
        </div>
        <div className="qr-pages">
          <Cover r={r} g={g} />
          {heads.includes("glance") ? <Glance r={r} g={g} /> : null}
          <Story r={r} g={g} />
          <Market r={r} g={g} market={market} setMarket={setMarket} />
          {heads.includes("plan") ? <Plan r={r} g={g} /> : null}
          {heads.includes("score") ? <Scorecard r={r} g={g} /> : null}
          {heads.includes("old") ? <OldNew r={r} g={g} /> : null}
          <Health r={r} g={g} benchmarks={benchmarks} index={index} setIndex={(isin, code) => setIndexState((s) => ({ ...s, [isin]: code }))} />
          {heads.includes("rebalance") ? <Rebalance r={r} g={g} /> : null}
          <Structure r={r} g={g} />
          {heads.includes("sip") ? <Sip r={r} g={g} /> : null}
          <Tax r={r} g={g} />
          <Projections r={r} />
          <Actions r={r} g={g} />
        </div>
      </div>
    </Edit.Provider>
  );
}
