/**
 * The quarterly review as an A4 landscape PDF (navy and gold, Univest Wealth), laid out from a
 * QuarterlyReport. Server only: fonts are read from node_modules (Lato, Source Serif 4, with
 * Noto Sans / Source Serif latin-ext for the ₹ sign) and traced into the deployment in next.config.
 * Pages without content for this client (no exits, nothing left to do) are left out.
 */
import path from "node:path";
import { Document, Font, Page, Path, Polyline, Line, Svg, Text, View, renderToBuffer, StyleSheet } from "@react-pdf/renderer";
import type { Styles } from "@react-pdf/renderer";

type Style = Styles[string];
import type { ReactNode } from "react";
import { date, L, pageHeads, pct, R, RIA, share, signed } from "@/lib/domain/quarterly-format";
import { formatINR } from "@/lib/format";
import { croreWhen, type QuarterlyReport } from "@/lib/domain/quarterly-report";
import { PROJECTION_YEARS } from "@/lib/domain/quarterly";

export { RIA };

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

export const FONT_FILES = [
  "@fontsource/lato/files/lato-latin-400-normal.woff",
  "@fontsource/lato/files/lato-latin-700-normal.woff",
  "@fontsource/lato/files/lato-latin-400-italic.woff",
  "@fontsource/noto-sans/files/noto-sans-latin-ext-400-normal.woff",
  "@fontsource/noto-sans/files/noto-sans-latin-ext-700-normal.woff",
  "@fontsource/source-serif-4/files/source-serif-4-latin-400-normal.woff",
  "@fontsource/source-serif-4/files/source-serif-4-latin-600-normal.woff",
  "@fontsource/source-serif-4/files/source-serif-4-latin-700-normal.woff",
  "@fontsource/source-serif-4/files/source-serif-4-latin-400-italic.woff",
  "@fontsource/source-serif-4/files/source-serif-4-latin-ext-400-normal.woff",
  "@fontsource/source-serif-4/files/source-serif-4-latin-ext-600-normal.woff",
  "@fontsource/source-serif-4/files/source-serif-4-latin-ext-700-normal.woff",
  "@fontsource/source-serif-4/files/source-serif-4-latin-ext-400-italic.woff",
];

let fontsReady = false;
function registerFonts() {
  if (fontsReady) return;
  const f = (p: string) => path.join(process.cwd(), "node_modules", p);
  Font.register({ family: "Sans", fonts: [
    { src: f(FONT_FILES[0]), fontWeight: 400 }, { src: f(FONT_FILES[1]), fontWeight: 700 }, { src: f(FONT_FILES[2]), fontWeight: 400, fontStyle: "italic" },
  ] });
  Font.register({ family: "SansExt", fonts: [
    { src: f(FONT_FILES[3]), fontWeight: 400 }, { src: f(FONT_FILES[4]), fontWeight: 700 }, { src: f(FONT_FILES[3]), fontWeight: 400, fontStyle: "italic" },
  ] });
  Font.register({ family: "Serif", fonts: [
    { src: f(FONT_FILES[5]), fontWeight: 400 }, { src: f(FONT_FILES[6]), fontWeight: 600 }, { src: f(FONT_FILES[7]), fontWeight: 700 },
    { src: f(FONT_FILES[8]), fontWeight: 400, fontStyle: "italic" },
  ] });
  Font.register({ family: "SerifExt", fonts: [
    { src: f(FONT_FILES[9]), fontWeight: 400 }, { src: f(FONT_FILES[10]), fontWeight: 600 }, { src: f(FONT_FILES[11]), fontWeight: 700 },
    { src: f(FONT_FILES[12]), fontWeight: 400, fontStyle: "italic" },
  ] });
  Font.registerHyphenationCallback((w) => [w]);
  fontsReady = true;
}

// ---------------------------------------------------------------------------
// Look
// ---------------------------------------------------------------------------

const C = {
  navy: "#0D1F3C", navy2: "#1E3A63", gold: "#B8932F", goldSoft: "#E5C76B", ink: "#1C2533", muted: "#6B7385", line: "#E3E5EA",
  green: "#2F6D4A", greenBg: "#EEF4F0", amber: "#B57A1E", amberBg: "#FBF5EA", red: "#A23B2C", cream: "#F7F4EC", steel: "#8E9AAD",
  blue: "#3E6587", blue2: "#8FB0C8", pale: "#C9CED8",
};
const SANS = ["Sans", "SansExt"];
const SERIF = ["Serif", "SerifExt"];

const s = StyleSheet.create({
  page: { fontFamily: SANS, fontSize: 8.5, color: C.ink, paddingTop: 30, paddingBottom: 46, paddingHorizontal: 44 },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", borderBottomWidth: 0.75, borderBottomColor: C.gold, paddingBottom: 9, marginBottom: 18 },
  brand: { fontFamily: SERIF, fontWeight: 700, fontSize: 11.5, letterSpacing: 1.8, color: C.navy },
  section: { fontSize: 7.5, letterSpacing: 1.4, color: C.muted },
  eyebrow: { fontSize: 7, letterSpacing: 1.6, color: C.gold, fontWeight: 700, marginBottom: 3 },
  title: { fontFamily: SERIF, fontSize: 21, color: C.navy, marginBottom: 14, lineHeight: 1.2 },
  h3: { fontFamily: SERIF, fontWeight: 700, fontSize: 11, color: C.navy, marginBottom: 7 },
  foot: { position: "absolute", left: 44, right: 44, bottom: 22, flexDirection: "row", justifyContent: "space-between", borderTopWidth: 0.5, borderTopColor: C.line, paddingTop: 6, fontSize: 6.8, color: C.muted },
  small: { fontSize: 6.8, color: C.muted, lineHeight: 1.45 },
  body: { fontSize: 8.6, lineHeight: 1.55 },
  th: { fontSize: 6.3, letterSpacing: 0.8, color: C.muted, fontWeight: 700 },
  td: { fontSize: 7.8, lineHeight: 1.4 },
  b: { fontWeight: 700 },
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const up = (x: number | null | undefined) => (x == null ? C.ink : x >= 0 ? C.green : C.red);

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function Brand({ light }: { light?: boolean }) {
  return <Text style={[s.brand, light ? { color: "#FFFFFF" } : {}]}>UNIVEST <Text style={{ color: C.gold }}>WEALTH</Text></Text>;
}

function Frame({ r, page, children }: { r: QuarterlyReport; page: string; children: ReactNode }) {
  const { section, eyebrow, title } = pageHeads(r).find((p) => p.key === page)!;
  return (
    <Page size="A4" orientation="landscape" style={s.page}>
      <View style={s.head} fixed>
        <Brand />
        <Text style={s.section}>{section.toUpperCase()}</Text>
      </View>
      <Text style={s.eyebrow}>{eyebrow.toUpperCase()}</Text>
      <Text style={s.title}>{title}</Text>
      {children}
      <View style={s.foot} fixed>
        <Text render={({ pageNumber }) => `Univest Wealth Quarterly Review — ${r.client.name} — Page ${pageNumber}`} />
        <Text>{RIA} · Private &amp; confidential</Text>
      </View>
    </Page>
  );
}

function Kpis({ items, dark }: { items: { label: string; value: string; sub?: string; color?: string }[]; dark?: boolean }) {
  return (
    <View style={{ flexDirection: "row", gap: 22, marginBottom: 16 }}>
      {items.map((k) => (
        <View key={k.label} style={{ flex: 1, borderTopWidth: 1.4, borderTopColor: C.gold, paddingTop: 8 }}>
          <Text style={{ fontSize: 6.6, letterSpacing: 1.1, color: dark ? "#B9C3D6" : C.muted, marginBottom: 4 }}>{k.label.toUpperCase()}</Text>
          <Text style={{ fontFamily: SERIF, fontSize: 19, color: k.color ?? (dark ? "#FFFFFF" : C.navy), marginBottom: 3 }}>{k.value}</Text>
          {k.sub ? <Text style={{ fontSize: 6.8, color: dark ? "#B9C3D6" : C.muted }}>{k.sub}</Text> : null}
        </View>
      ))}
    </View>
  );
}

const PILL: Record<string, [string, string]> = {
  DONE: [C.green, C.greenBg], GREEN: [C.green, C.greenBg], RUNNING: [C.green, C.greenBg], OPEN: [C.green, C.greenBg], CHEAP: [C.green, C.greenBg],
  PARTLY: [C.amber, C.amberBg], AMBER: [C.amber, C.amberBg], CONFIRM: [C.navy2, "#EDF1F7"], STRETCHED: [C.amber, C.amberBg], PAUSED: [C.amber, C.amberBg], CHANGE: [C.navy2, "#EDF1F7"], START: [C.navy2, "#EDF1F7"],
  "NOT DONE": [C.red, "#FBEEEC"], RED: [C.red, "#FBEEEC"], EXIT: [C.red, "#FBEEEC"], STOP: [C.red, "#FBEEEC"],
  FAIR: [C.green, C.greenBg], NOTE: [C.muted, "#F1F2F5"], LOCKED: [C.muted, "#F1F2F5"], "NOT IN PLAN": [C.muted, "#F1F2F5"],
};
function Pill({ label }: { label: string }) {
  const [fg, bg] = PILL[label] ?? [C.muted, "#F1F2F5"];
  return (
    <View style={{ alignSelf: "center", borderWidth: 0.8, borderColor: fg, backgroundColor: bg, borderRadius: 7, paddingHorizontal: 6, paddingVertical: 1.6 }}>
      <Text style={{ fontSize: 5.8, letterSpacing: 0.8, fontWeight: 700, color: fg }}>{label}</Text>
    </View>
  );
}

function Callout({ children, tone = "gold", style }: { children: ReactNode; tone?: "gold" | "green" | "amber"; style?: Style }) {
  const border = tone === "green" ? C.green : tone === "amber" ? C.amber : C.gold;
  const bg = tone === "green" ? C.greenBg : tone === "amber" ? C.amberBg : C.cream;
  return <View style={[{ borderLeftWidth: 2.5, borderLeftColor: border, backgroundColor: bg, paddingVertical: 9, paddingHorizontal: 12 }, style ?? {}]} wrap={false}><Text style={s.body}>{children}</Text></View>;
}

type Col<T> = { head: string; w: number; align?: "left" | "right" | "center"; cell: (row: T) => ReactNode; bold?: boolean };
function Table<T>({ cols, rows, total }: { cols: Col<T>[]; rows: T[]; total?: Record<number, ReactNode> }) {
  const cellStyle = (c: Col<T>) => ({ flex: c.w, paddingHorizontal: 4, textAlign: c.align ?? "left" } as const);
  return (
    <View>
      <View style={{ flexDirection: "row", borderBottomWidth: 0.9, borderBottomColor: C.navy, paddingBottom: 5, alignItems: "flex-end" }} fixed>
        {cols.map((c) => <Text key={c.head} style={[s.th, cellStyle(c)]}>{c.head.toUpperCase()}</Text>)}
      </View>
      {rows.map((row, i) => (
        <View key={i} style={{ flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: C.line, paddingVertical: 4.6, alignItems: "flex-start" }} wrap={false}>
          {cols.map((c) => {
            const v = c.cell(row);
            return typeof v === "string" || typeof v === "number"
              ? <Text key={c.head} style={[s.td, cellStyle(c), c.bold ? s.b : {}]}>{v}</Text>
              : <View key={c.head} style={[cellStyle(c), { alignItems: c.align === "right" ? "flex-end" : c.align === "center" ? "center" : "flex-start" }]}>{v}</View>;
          })}
        </View>
      ))}
      {total ? (
        <View style={{ flexDirection: "row", paddingVertical: 5 }} wrap={false}>
          {cols.map((c, i) => <Text key={c.head} style={[s.td, s.b, cellStyle(c)]}>{(total[i] as string) ?? ""}</Text>)}
        </View>
      ) : null}
    </View>
  );
}

/** Horizontal bars around zero, for returns; labels sit outside the bar ends. */
function Bars({ items, width = 330, min, max }: { items: { label: string; value: number; color: string }[]; width?: number; min?: number; max?: number }) {
  const lo = Math.min(min ?? 0, ...items.map((i) => i.value), 0);
  const hi = Math.max(max ?? 0, ...items.map((i) => i.value), 0);
  const span = hi - lo || 1;
  const labelW = 120;
  const plot = width - labelW;
  const gutter = 38;
  const x = (v: number) => gutter + ((v - lo) / span) * (plot - gutter * 2);
  return (
    <View>
      {items.map((it) => {
        const a = Math.min(x(0), x(it.value));
        const w = Math.max(1.5, Math.abs(x(it.value) - x(0)));
        return (
          <View key={it.label} style={{ flexDirection: "row", alignItems: "center", marginBottom: 8 }} wrap={false}>
            <Text style={{ width: labelW, textAlign: "right", paddingRight: 8, fontSize: 7.8 }}>{it.label}</Text>
            <View style={{ width: plot, height: 13, position: "relative" }}>
              <View style={{ position: "absolute", left: x(0), top: -3, height: 19, borderLeftWidth: 0.6, borderLeftColor: C.pale }} />
              <View style={{ position: "absolute", left: a, width: w, top: 0, height: 13, backgroundColor: it.color }} />
              <Text style={{ position: "absolute", top: 3, fontSize: 7, fontWeight: 700, ...(it.value >= 0 ? { left: a + w + 4 } : { left: a - 38, width: 34, textAlign: "right" }) }}>{pct(it.value)}</Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

function arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const p = (a: number) => [cx + r * Math.sin(a), cy - r * Math.cos(a)];
  const [x0, y0] = p(a0);
  const [x1, y1] = p(a1);
  return `M ${x0} ${y0} A ${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1} ${y1}`;
}

function Donut({ parts, label }: { parts: { value: number; color: string }[]; label: string }) {
  const total = parts.reduce((t, p) => t + p.value, 0) || 1;
  // Start and end angle of each slice, worked out before drawing.
  const shown = parts.filter((p) => p.value > 0);
  const ends = shown.map((_, i) => shown.slice(0, i + 1).reduce((t, p) => t + p.value, 0) / total * Math.PI * 2);
  return (
    <View style={{ width: 132, height: 132, position: "relative" }}>
      <Svg width={132} height={132} viewBox="0 0 132 132">
        {shown.map((p, i) => {
          const a0 = i ? ends[i - 1] : 0;
          return <Path key={i} d={arc(66, 66, 50, a0, Math.min(ends[i], a0 + Math.PI * 2 - 0.0001))} stroke={p.color} strokeWidth={22} fill="none" />;
        })}
      </Svg>
      <Text style={{ position: "absolute", top: 60, left: 0, width: 132, textAlign: "center", fontFamily: SERIF, fontSize: 8.5 }}>{label}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function Cover({ r }: { r: QuarterlyReport }) {
  const m = r.money;
  return (
    <Page size="A4" orientation="landscape" style={{ backgroundColor: C.navy, color: "#FFFFFF", fontFamily: SANS, paddingHorizontal: 64, paddingTop: 52, paddingBottom: 48 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={[s.brand, { color: "#FFFFFF", fontSize: 14 }]}>UNIVEST <Text style={{ color: C.gold }}>WEALTH</Text></Text>
        <Text style={{ fontSize: 7.5, letterSpacing: 1.4, color: C.gold }}>{RIA}</Text>
      </View>
      <View style={{ marginTop: 92 }}>
        <Text style={{ fontSize: 8, letterSpacing: 2.2, color: C.gold, fontWeight: 700, marginBottom: 12 }}>QUARTERLY PORTFOLIO REVIEW · UPDATED TO {date(r.asOf).toUpperCase()}</Text>
        <Text style={{ fontFamily: SERIF, fontSize: 40, marginBottom: 14 }}>{r.client.name}</Text>
        <Text style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 13.5, color: "#E3DCC6", marginBottom: 16 }}>{r.texts.tagline}</Text>
        <Text style={{ fontSize: 7.6, color: "#C3CCDB" }}>
          Review {r.reviewNo} · {r.quarterLabel} · Review period {date(r.windowStart)} – {date(r.windowEnd)} · CAS of {date(r.casDate)}, units revalued at AMFI NAV of {date(r.asOf)} · Prepared {date(r.prepared)}
        </Text>
      </View>
      <View style={{ position: "absolute", left: 64, right: 64, bottom: 54 }}>
        <Kpis dark items={[
          { label: "Portfolio value", value: L(r.totals.value), sub: `${date(r.asOf)} · ${r.totals.funds} fund${r.totals.funds === 1 ? "" : "s"}` },
          { label: `Nifty 50 since ${date(r.windowStart, false)}`, value: pct(m.niftySinceStart), sub: `${date(r.windowStart, false)} – ${date(r.asOf, false)}` },
          { label: "Your new money", value: pct(m.ret), color: C.goldSoft, sub: m.aheadOfNifty != null ? `${formatINR(Math.abs(m.aheadOfNifty))} ${m.aheadOfNifty >= 0 ? "ahead of" : "behind"} Nifty 50` : m.deployed ? `on ${L(m.deployed)} put in` : "no new money this quarter" },
          { label: "Monthly SIP from next month", value: r.sip.fromNext ? R(r.sip.fromNext) : "—", color: C.goldSoft, sub: `${r.sip.rows.filter((x) => x.amount > 0).length} fund${r.sip.rows.filter((x) => x.amount > 0).length === 1 ? "" : "s"}` },
        ]} />
      </View>
    </Page>
  );
}

function Glance({ r }: { r: QuarterlyReport }) {
  const t = r.totals;
  const m = r.money;
  const bars = [
    m.niftyRet != null ? { label: "Same cash in Nifty 50", value: m.niftyRet, color: C.steel } : null,
    m.ret != null ? { label: "Your new funds (actual)", value: m.ret, color: C.gold } : null,
  ].filter((b): b is { label: string; value: number; color: string } => b !== null);
  return (
    <Frame r={r} page="glance">
      <Kpis items={[
        { label: "Total invested (cost)", value: L(t.cost), sub: "current holdings, per CAS" },
        { label: `Value on ${date(r.asOf, false)}`, value: L(t.value), sub: `${L(t.casValue)} at your ${date(r.casDate, false)} CAS` },
        { label: "Gain on cost", value: signed(t.gain), color: up(t.gain), sub: `${pct(t.gainPct)} absolute${t.xirr != null ? ` · XIRR ${pct(t.xirr)}` : ""}` },
        r.casDate < r.asOf
          ? { label: "Since your CAS", value: signed(t.sinceCas), color: up(t.sinceCas), sub: `${pct(t.sinceCasPct)} · ${date(r.casDate, false)} – ${date(r.asOf, false)}` }
          : { label: "Funds held", value: String(t.funds), sub: `as of your ${date(r.casDate, false)} CAS` },
      ]} />
      <View style={{ flexDirection: "row", gap: 30 }}>
        <View style={{ flex: 1 }}>
          <Text style={s.h3}>The review in one line</Text>
          <Text style={{ fontFamily: SERIF, fontSize: 12.5, lineHeight: 1.45, color: C.navy, marginBottom: 9 }}>{r.texts.headline}</Text>
          {r.texts.glance.map((g, i) => <Text key={i} style={[s.body, { marginBottom: 6 }]}>{g}</Text>)}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={s.h3}>New money: same rupees, same dates</Text>
          {bars.length ? <Bars items={bars} /> : <Text style={s.small}>No new money went in during this review period.</Text>}
          <Text style={[s.small, { marginTop: 6 }]}>
            {m.deployed ? `Return on ${R(m.deployed)} put in ${date(r.windowStart, false)} – ${date(r.windowEnd, false)}, valued at ${date(r.asOf)} NAVs. ` : ""}
            {t.years < 1 ? "Under a year of history is too short to annualise; all figures are absolute. " : ""}
            {m.indexAsOf ? `The Nifty 50 comparison uses Direct-plan index-fund NAVs to ${date(m.indexAsOf)}.` : ""}
          </Text>
        </View>
      </View>
    </Frame>
  );
}

function Story({ r }: { r: QuarterlyReport }) {
  const m = r.money;
  return (
    <Frame r={r} page="story">
      <View style={{ flexDirection: "row", gap: 10, marginBottom: 16 }}>
        {r.story.map((c, i) => (
          <View key={i} style={{ flex: 1, backgroundColor: C.cream, borderTopWidth: 1.4, borderTopColor: C.gold, padding: 10, minHeight: 150 }}>
            <Text style={{ fontSize: 6.6, letterSpacing: 1.2, color: C.gold, fontWeight: 700, marginBottom: 6 }}>{c.when.toUpperCase()}</Text>
            <Text style={{ fontFamily: SERIF, fontSize: 11, color: C.navy, marginBottom: 7 }}>{c.title}</Text>
            <Text style={{ fontSize: 7.6, lineHeight: 1.5 }}>{c.text}</Text>
          </View>
        ))}
      </View>
      <Kpis items={[
        { label: "Recycled from old funds", value: L(Math.min(m.recycled, m.deployed || m.recycled)), sub: "sales in this period" },
        { label: "Fresh money added", value: L(m.fresh), sub: "beyond the sale proceeds" },
        { label: "Added by the switch", value: r.old ? signed(r.old.added, false) : "—", color: r.old ? up(r.old.added) : undefined, sub: r.old ? "vs keeping the old funds" : "no exits this period" },
        { label: "Ahead of Nifty 50", value: m.aheadOfNifty != null ? signed(m.aheadOfNifty) : "—", color: up(m.aheadOfNifty), sub: "same rupees, same dates" },
      ]} />
      {r.texts.storySentence ? <Callout><Text style={s.b}>In one sentence: </Text>{r.texts.storySentence}</Callout> : null}
    </Frame>
  );
}

function Market({ r }: { r: QuarterlyReport }) {
  const mk = r.market;
  return (
    <Frame r={r} page="market">
      <View style={{ flexDirection: "row", gap: 30 }}>
        <View style={{ flex: 1 }}>
          <Text style={s.h3}>Index moves over your review window</Text>
          {mk.moves.length ? <Bars items={mk.moves.map((x, i) => ({ label: x.label, value: x.pct, color: i < 2 ? (x.pct < 0 ? C.navy2 : C.blue) : C.blue2 }))} width={340} /> : <Text style={s.small}>Index history is not available yet.</Text>}
          <Text style={[s.small, { marginTop: 6 }]}>Moves of Direct-plan index funds tracking each index{r.money.indexAsOf ? `, to ${date(r.money.indexAsOf)}` : ""}.</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={s.h3}>Valuations vs their 5-year median</Text>
          {mk.valuations.length ? (
            <Table rows={mk.valuations} cols={[
              { head: "Index", w: 3, cell: (v) => v.index },
              { head: "P/E now", w: 1.3, align: "right", cell: (v) => v.peNow.toFixed(1) },
              { head: "5Y median", w: 1.5, align: "right", cell: (v) => v.median.toFixed(1) },
              { head: "Gap", w: 1.2, align: "right", cell: (v) => pct(v.gap, 0) },
              { head: "Read", w: 1.8, align: "center", cell: (v) => <Pill label={v.read} /> },
            ]} />
          ) : <Text style={s.small}>Valuations for this quarter are not entered yet.</Text>}
          {mk.asOf ? <Text style={[s.small, { marginTop: 5 }]}>P/E as of {mk.asOf}.</Text> : null}
          {r.texts.marketNote ? <Callout style={{ marginTop: 12 }}><Text style={s.b}>What it means for you. </Text>{r.texts.marketNote}</Callout> : null}
        </View>
      </View>
    </Frame>
  );
}

function Plan({ r }: { r: QuarterlyReport }) {
  return (
    <Frame r={r} page="plan">
      <Table rows={r.plan.rows} cols={[
        { head: "What happened", w: 3.2, bold: true, cell: (x) => x.what },
        { head: "Detail", w: 6.2, cell: (x) => x.detail },
        { head: "Status", w: 1.2, align: "center", cell: (x) => <Pill label={x.status} /> },
      ]} />
      <Callout style={{ marginTop: 14 }}><Text style={s.b}>Execution: {r.plan.done} of {r.plan.total} plan lines done. </Text>{r.texts.planCallout}</Callout>
    </Frame>
  );
}

function Scorecard({ r }: { r: QuarterlyReport }) {
  const sc = r.score;
  return (
    <Frame r={r} page="score">
      <Table rows={sc.rows} cols={[
        { head: "Fund", w: 3.4, bold: true, cell: (x) => x.name },
        { head: "New money in", w: 1.6, align: "right", cell: (x) => R(x.newIn) },
        { head: `Worth on ${date(r.asOf, false)}`, w: 1.7, align: "right", cell: (x) => R(x.worth) },
        { head: "Return", w: 1.1, align: "right", cell: (x) => <Text style={[s.td, s.b, { color: up(x.ret) }]}>{pct(x.ret)}</Text> },
        { head: "Own index", w: 1.8, align: "right", cell: (x) => x.index ?? "—" },
        { head: "Ahead / behind index", w: 2, align: "right", cell: (x) => x.ahead == null ? "—" : <Text style={[s.td, s.b, { color: up(x.ahead) }]}>{signed(x.ahead)}</Text> },
      ]} total={{ 0: "All new money", 1: R(sc.total.newIn), 2: R(sc.total.worth), 3: pct(sc.total.ret) }} />
      <View style={{ flexDirection: "row", gap: 14, marginTop: 12 }}>
        {r.texts.winnersNote ? <Callout tone="green" style={{ flex: 1 }}>{r.texts.winnersNote}</Callout> : null}
        {r.texts.laggardNote ? <Callout tone="amber" style={{ flex: 1 }}>{r.texts.laggardNote}</Callout> : null}
      </View>
      <Text style={[s.small, { marginTop: 8 }]}>
        Values use {date(r.asOf)} NAVs on your units. Each purchase is replayed into a Direct-plan index fund on the same date{r.money.indexAsOf ? `, valued to ${date(r.money.indexAsOf)}` : ""}. Funds without a fitting index show “—”.
      </Text>
    </Frame>
  );
}

function OldNew({ r }: { r: QuarterlyReport }) {
  const o = r.old!;
  return (
    <Frame r={r} page="old">
      <View style={{ flexDirection: "row", gap: 30 }}>
        <View style={{ flex: 1.1 }}>
          <Text style={s.h3}>The money we moved: {L(o.soldFor)}</Text>
          <Table rows={o.rows} cols={[
            { head: "Old fund", w: 3.2, cell: (x) => <View><Text style={[s.td, s.b]}>{x.name}</Text><Text style={s.small}>{x.units.toFixed(0)} units sold</Text></View> },
            { head: "Sold for", w: 1.5, align: "right", cell: (x) => R(x.soldFor) },
            { head: "Worth today if kept", w: 1.9, align: "right", cell: (x) => R(x.worthIfKept) },
            { head: "Return", w: 1, align: "right", cell: (x) => pct(x.ret) },
          ]} total={{ 0: "Old funds", 1: R(o.soldFor), 2: R(o.worthIfKept), 3: pct(o.oldRet) }} />
          <View style={{ height: 10 }} />
          <Table rows={o.newRows} cols={[
            { head: "Where the money went", w: 3.2, bold: true, cell: (x) => x.name },
            { head: "Put in", w: 1.5, align: "right", cell: (x) => R(x.putIn) },
            { head: "Worth today", w: 1.9, align: "right", cell: (x) => R(x.worth) },
            { head: "Return", w: 1, align: "right", cell: (x) => pct(x.ret) },
          ]} />
          <Text style={[s.small, { marginTop: 6 }]}>Old funds are valued at {date(r.asOf)} NAVs on the units sold (dividends they would have paid are not added). The new-money return is applied to the sale proceeds.</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={s.h3}>Old portfolio vs new portfolio</Text>
          <Bars items={[{ label: "Kept the old funds", value: o.oldRet, color: C.steel }, { label: "Moved to the new funds", value: o.newRet, color: C.gold }]} width={330} />
          <View style={{ height: 6 }} />
          <Kpis items={[
            { label: "Additional value created", value: signed(o.added), color: up(o.added), sub: "on the money we moved" },
            { label: "Book today", value: L(r.totals.value), sub: "new portfolio" },
            { label: "Book if nothing moved", value: L(o.bookIfKept), color: C.steel, sub: "old funds kept" },
          ]} />
          {r.texts.oldVsNewNote ? <Callout tone={o.added >= -500 ? "green" : "amber"}>{r.texts.oldVsNewNote}</Callout> : null}
        </View>
      </View>
    </Frame>
  );
}

function Health({ r }: { r: QuarterlyReport }) {
  return (
    <Frame r={r} page="health">
      <Table rows={r.health} cols={[
        { head: "Fund", w: 3.2, bold: true, cell: (x) => x.name },
        { head: `Value ${date(r.asOf, false)}`, w: 1.4, align: "right", cell: (x) => R(x.value) },
        { head: "Weight", w: 0.9, align: "right", cell: (x) => share(x.weight) },
        { head: "On cost", w: 0.9, align: "right", cell: (x) => pct(x.onCost) },
        ...(r.casDate < r.asOf ? [{ head: `${date(r.casDate, false)} – ${date(r.asOf, false)}`, w: 1.3, align: "right" as const, cell: (x: (typeof r.health)[number]) => pct(x.sinceCas) }] : []),
        { head: "Status", w: 1, align: "center", cell: (x) => (x.status ? <Pill label={x.status} /> : "—") },
        { head: "Why", w: 4.6, cell: (x) => <Text style={[s.td, { color: C.muted }]}>{x.why}</Text> },
      ]} total={{ 0: "Portfolio", 1: R(r.totals.value), 2: "100%", 3: pct(r.totals.gainPct), ...(r.casDate < r.asOf ? { 4: pct(r.totals.sinceCasPct) } : {}) }} />
      <Text style={[s.small, { marginTop: 6 }]}>Return on cost is absolute. Cost is the CAS cost, or worked out from your transactions when the CAS gives none.</Text>
    </Frame>
  );
}

function Rebalance({ r }: { r: QuarterlyReport }) {
  const rb = r.rebalance!;
  return (
    <Frame r={r} page="rebalance">
      <Kpis items={[
        { label: "Redeemed", value: rb.redeemed ? R(rb.redeemed) : "—", sub: `${rb.sells.length} line${rb.sells.length === 1 ? "" : "s"}` },
        { label: "Reinvested", value: rb.reinvested ? R(rb.reinvested) : "—", sub: `${rb.buys.length} fund${rb.buys.length === 1 ? "" : "s"} · Direct plans` },
        ...(rb.topAmc ? [{ label: `${rb.topAmc.name} weight`, value: share(rb.topAmc.after), color: C.gold, sub: `from ${share(rb.topAmc.now)} now` }] : []),
      ]} />
      <View style={{ flexDirection: "row", gap: 30 }}>
        {rb.sells.length ? (
          <View style={{ flex: 1 }}>
            <Text style={s.h3}>What we sell</Text>
            <Table rows={rb.sells} cols={[
              { head: "Redeem", w: 3, bold: true, cell: (x) => x.name },
              { head: "Units", w: 1.2, align: "right", cell: (x) => (x.units == null ? "—" : x.units.toFixed(3)) },
              { head: `Value at ${date(r.asOf, false)} NAV`, w: 1.7, align: "right", cell: (x) => R(x.value) },
              { head: "Gain vs cost", w: 1.3, align: "right", cell: (x) => (x.gain == null ? "—" : R(x.gain)) },
            ]} total={{ 0: "Total redemption", 2: R(rb.redeemed), 3: R(rb.sells.reduce((t, x) => t + (x.gain ?? 0), 0)) }} />
            <Text style={[s.small, { marginTop: 5 }]}>Amounts at {date(r.asOf)} NAV; the final figure is set by the NAV on the redemption date.</Text>
          </View>
        ) : null}
        {rb.buys.length ? (
          <View style={{ flex: 1.2 }}>
            <Text style={s.h3}>What we buy</Text>
            <Table rows={rb.buys} cols={[
              { head: "Buy", w: 2.6, bold: true, cell: (x) => x.name },
              { head: "Amount", w: 1.3, align: "right", cell: (x) => R(x.amount) },
              { head: "Funded by", w: 1.5, cell: (x) => x.fundedBy },
              { head: "Lumpsum", w: 1.2, align: "center", cell: (x) => <Pill label={x.lumpsum} /> },
              { head: "SIP", w: 1, align: "center", cell: (x) => <Pill label={x.sip} /> },
              { head: "Why", w: 2.8, cell: (x) => <Text style={[s.td, { color: C.muted }]}>{x.why}</Text> },
            ]} total={{ 0: "Total buy", 1: R(rb.reinvested) }} />
            <Text style={[s.small, { marginTop: 5 }]}>Lumpsum and SIP status as of this review; confirm on the order screen.{r.texts.rebalanceNote ? ` ${r.texts.rebalanceNote}` : ""}</Text>
          </View>
        ) : null}
      </View>
    </Frame>
  );
}

const CAP_COLORS: Record<string, string> = { "Large cap": C.navy, "Large & mid": C.navy2, "Mid cap": C.blue, "Small cap": C.blue2, "Flexi / multi": "#A9B7C9", Sectoral: C.gold, Other: C.pale };

function Structure({ r }: { r: QuarterlyReport }) {
  const st = r.structure;
  const hasBefore = st.rows.some((x) => x.before != null);
  return (
    <Frame r={r} page="structure">
      <View style={{ flexDirection: "row", gap: 30 }}>
        <View style={{ flex: 1.2 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-around" }}>
            <Donut label={`Now · ${date(r.asOf, false)}`} parts={st.rows.map((x) => ({ value: x.now, color: CAP_COLORS[x.label] }))} />
            {st.changes ? <Donut label="After rebalance" parts={st.rows.map((x) => ({ value: x.after, color: CAP_COLORS[x.label] }))} /> : null}
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, justifyContent: "center", marginTop: 10 }}>
            {st.rows.map((x) => (
              <View key={x.label} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                <View style={{ width: 7, height: 7, backgroundColor: CAP_COLORS[x.label] }} />
                <Text style={{ fontSize: 7.2 }}>{x.label}</Text>
              </View>
            ))}
          </View>
          <Text style={[s.small, { marginTop: 8 }]}>By each fund’s category. Flexi, multi, focused, value and ELSS funds hold large, mid and small companies together and are shown as one group.</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Table rows={st.rows} cols={[
            { head: "Segment", w: 2, cell: (x) => x.label },
            ...(hasBefore ? [{ head: "At onboarding", w: 1.4, align: "right" as const, cell: (x: (typeof st.rows)[number]) => share(x.before) }] : []),
            { head: "Now", w: 1, align: "right", cell: (x) => share(x.now) },
            ...(st.changes ? [{ head: "After", w: 1.1, align: "right" as const, cell: (x: (typeof st.rows)[number]) => share(x.after) }] : []),
          ]} />
          <View style={{ height: 10 }} />
          <Table rows={st.amc} cols={[
            { head: "Fund house", w: 2.4, cell: (x) => x.name },
            { head: "Now", w: 1, align: "right", cell: (x) => share(x.now) },
            ...(st.changes ? [{ head: "After", w: 1, align: "right" as const, cell: (x: (typeof st.amc)[number]) => share(x.after) }] : []),
            { head: "Limit 35%", w: 1.2, align: "center", cell: (x) => (x.name === "Other" ? "—" : <Pill label={Math.max(x.now, st.changes ? x.after : 0) > 0.35 ? "RED" : "GREEN"} />) },
          ]} />
          {r.texts.structureNote ? <><Text style={[s.h3, { marginTop: 12 }]}>What changes</Text><Text style={s.body}>{r.texts.structureNote}</Text></> : null}
        </View>
      </View>
    </Frame>
  );
}

function Sip({ r }: { r: QuarterlyReport }) {
  const sp = r.sip;
  return (
    <Frame r={r} page="sip">
      <Kpis items={[
        { label: "Last quarter (average)", value: sp.lastQuarter ? `~${R(Math.round(sp.lastQuarter / 100) * 100)}` : "—", sub: "per month, from your CAS" },
        { label: "From next month", value: sp.fromNext ? R(sp.fromNext) : "—", color: C.gold, sub: `${sp.rows.filter((x) => x.amount > 0).length} fund${sp.rows.filter((x) => x.amount > 0).length === 1 ? "" : "s"}` },
        { label: "No new money", value: `${sp.noNewMoney.length} fund${sp.noNewMoney.length === 1 ? "" : "s"}`, sub: sp.noNewMoney.length > 3 ? `${sp.noNewMoney.slice(0, 3).join(", ")} and ${sp.noNewMoney.length - 3} more` : sp.noNewMoney.join(", ") },
      ]} />
      <Table rows={sp.rows} cols={[
        { head: "Fund", w: 4, cell: (x) => <Text style={s.td}><Text style={s.b}>{x.name}</Text>  <Text style={{ color: C.muted, fontSize: 6.8 }}>{x.category}</Text></Text> },
        { head: "Monthly SIP", w: 1.4, align: "right", cell: (x) => (x.amount ? R(x.amount) : "Stop") },
        { head: "Status", w: 1.2, align: "center", cell: (x) => <Pill label={x.action} /> },
        { head: "Why", w: 4.2, cell: (x) => <Text style={[s.td, { color: C.muted }]}>{x.why}</Text> },
      ]} total={{ 0: "Monthly SIP", 1: R(sp.fromNext) }} />
      {r.texts.sipNote ? <Callout style={{ marginTop: 12 }}>{r.texts.sipNote}</Callout> : null}
    </Frame>
  );
}

function Tax({ r }: { r: QuarterlyReport }) {
  const tx = r.tax;
  return (
    <Frame r={r} page="tax">
      <View style={{ flexDirection: "row", gap: 30 }}>
        <View style={{ flex: 1.3 }}>
          {tx.lines.length ? (
            <Table rows={tx.lines} cols={[
              { head: "Line", w: 2.4, cell: (x) => x.name },
              { head: `Value ${date(r.asOf, false)}`, w: 1.3, align: "right", cell: (x) => R(x.value) },
              { head: "Cost", w: 1.2, align: "right", cell: (x) => (x.cost == null ? "—" : R(x.cost)) },
              { head: "Gain", w: 1, align: "right", cell: (x) => (x.gain == null ? "—" : R(x.gain)) },
              { head: "Likely treatment", w: 3, cell: (x) => x.treatment },
            ]} />
          ) : null}
          <View style={{ height: 12 }} />
          <Kpis items={[
            ...(tx.lines.length ? [{ label: "Est. tax on rebalance", value: R(tx.estTax), color: tx.estTax < 1 && !tx.slabExcluded ? C.green : C.ink,
              sub: tx.slabExcluded ? "plus slab-rate tax on short-term / debt gains" : tx.estTax < 1 ? "within the exemption" : "12.5% LT above the limit, 20% ST" }] : []),
            { label: `${tx.fy} gains booked`, value: R(Math.max(0, tx.gains.equityLt) + Math.max(0, tx.gains.equitySt)), sub: `long-term ${L(Math.max(0, tx.gains.equityLt))} · short-term ${L(Math.max(0, tx.gains.equitySt))}` },
            { label: "₹1.25L limit left", value: R(tx.gains.exemptionLeft), color: C.green, sub: "tax-free long-term equity gains" },
            ...(tx.exitLoad ? [{ label: "Est. exit load", value: `~${R(tx.exitLoad)}` }] : []),
          ]} />
          {tx.turningLong.length ? (
            <Table rows={tx.turningLong} cols={[
              { head: "Turns long-term on", w: 1.5, cell: (x) => date(x.date) },
              { head: "Fund", w: 3, cell: (x) => x.name },
              { head: "Value", w: 1.3, align: "right", cell: (x) => R(x.value) },
            ]} />
          ) : null}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={s.h3}>Notes</Text>
          {r.texts.taxNotes.map((n, i, all) => <Text key={i} style={[i === all.length - 1 ? s.small : s.body, { marginBottom: 6 }]}>{n}</Text>)}
        </View>
      </View>
    </Frame>
  );
}

function Projections({ r }: { r: QuarterlyReport }) {
  const p = r.projections;
  const W = 330;
  const H = 200;
  const all = p.rows.flatMap((x) => x.values).concat(p.start).filter((v) => v > 0);
  const lo = Math.log10(Math.max(1, Math.min(...all) * 0.8));
  const hi = Math.log10(Math.max(...all) * 1.15);
  const X = (yr: number) => 46 + (yr / 20) * (W - 56);
  const Y = (v: number) => H - 18 - ((Math.log10(Math.max(1, v)) - lo) / (hi - lo || 1)) * (H - 30);
  const ticks = [1e5, 2.5e5, 5e5, 1e6, 2.5e6, 5e6, 1e7, 2.5e7, 5e7, 1e8, 2.5e8, 5e8, 1e9].filter((t) => Math.log10(t) >= lo && Math.log10(t) <= hi);
  const color: Record<string, string> = { invested: C.pale, bear: C.steel, nifty: C.blue, base: C.gold, moonshot: C.navy };
  return (
    <Frame r={r} page="projections">
      <View style={{ flexDirection: "row", gap: 28 }}>
        <View style={{ width: W }}>
          <View style={{ width: W, height: H, position: "relative" }}>
            <Svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
              {ticks.map((t) => <Line key={t} x1={46} x2={W - 10} y1={Y(t)} y2={Y(t)} stroke={C.line} strokeWidth={0.5} />)}
              {p.rows.map((row) => (
                <Polyline key={row.key} fill="none" stroke={color[row.key]} strokeWidth={row.key === "base" ? 2 : 1.2} strokeDasharray={row.key === "invested" ? "3 2" : undefined}
                  points={[`${X(0)},${Y(p.start)}`, ...PROJECTION_YEARS.map((yr, i) => `${X(yr)},${Y(row.values[i])}`)].join(" ")} />
              ))}
            </Svg>
            {ticks.map((t) => <Text key={t} style={{ position: "absolute", left: 0, width: 42, textAlign: "right", top: Y(t) - 4, fontSize: 6.3, color: C.muted }}>{L(t).replace(".00", "")}</Text>)}
            {PROJECTION_YEARS.map((yr) => <Text key={yr} style={{ position: "absolute", left: X(yr) - 10, width: 20, textAlign: "center", top: H - 12, fontSize: 6.3, color: C.muted }}>{yr}Y</Text>)}
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 6 }}>
            {p.rows.map((row) => (
              <View key={row.key} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                <View style={{ width: 8, height: 8, backgroundColor: color[row.key] }} />
                <Text style={{ fontSize: 7 }}>{row.label}</Text>
              </View>
            ))}
          </View>
        </View>
        <View style={{ flex: 1 }}>
          <Table rows={p.rows} cols={[
            { head: "Scenario", w: 2.2, cell: (x) => x.label },
            ...PROJECTION_YEARS.map((yr, i) => ({ head: `${yr}Y`, w: 1.1, align: "right" as const, cell: (x: (typeof p.rows)[number]) => L(x.values[i]).replace(/(\.\d)0(?=L|Cr)/, "$1") })),
          ]} />
          <Callout style={{ marginTop: 12 }}>
            {p.crossesCrore != null && p.crossesCrore > 0 ? <Text style={s.b}>On the Base path the book crosses ₹1 Cr {croreWhen(p.crossesCrore)}. </Text> : null}
            Starting point: {L(p.start)} on {date(r.asOf, false)}{p.sip ? ` plus the ${R(p.sip)} monthly SIP` : ""}. The Nifty 50 line shows the same money in a plain index fund.
          </Callout>
          <Text style={[s.small, { marginTop: 6 }]}>
            Illustrations, not guarantees. Base {(p.rates.base * 100).toFixed(1).replace(/\.0$/, "")}% is our planning rate; Bear {(p.rates.bear * 100).toFixed(1).replace(/\.0$/, "")}% is roughly a fixed-deposit outcome; Moonshot reflects the chosen funds’ strongest 5-year stretch. Log scale.
          </Text>
        </View>
      </View>
    </Frame>
  );
}

function Actions({ r }: { r: QuarterlyReport }) {
  return (
    <Frame r={r} page="actions">
      <View style={{ flexDirection: "row", borderBottomWidth: 0.9, borderBottomColor: C.navy, paddingBottom: 5 }}>
        <Text style={[s.th, { width: 24 }]}>#</Text><Text style={[s.th, { flex: 1 }]}>ACTION</Text><Text style={[s.th, { width: 110 }]}>WHEN</Text>
      </View>
      {r.actions.map((a, i) => (
        <View key={i} style={{ flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: C.line, paddingVertical: 6 }} wrap={false}>
          <Text style={{ width: 24, fontFamily: SERIF, fontWeight: 700, fontSize: 13, color: C.gold }}>{i + 1}</Text>
          <View style={{ flex: 1, paddingRight: 10 }}>
            <Text style={[s.td, s.b, { marginBottom: 2 }]}>{a.title}</Text>
            <Text style={{ fontSize: 7.2, color: "#4A5263" }}>{a.detail}</Text>
          </View>
          <Text style={[s.td, s.b, { width: 110 }]}>{a.when}</Text>
        </View>
      ))}
      <View style={{ marginTop: 14, backgroundColor: C.navy, flexDirection: "row", paddingVertical: 14, paddingHorizontal: 20, gap: 24, alignItems: "center" }} wrap={false}>
        <View>
          <Text style={{ fontSize: 6.6, letterSpacing: 1.6, color: C.gold, marginBottom: 3 }}>NEXT REVIEW</Text>
          <Text style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 14, color: "#FFFFFF" }}>{r.texts.nextReview}</Text>
        </View>
        <Text style={{ flex: 1, fontSize: 8, color: "#E6EAF2", lineHeight: 1.5 }}>{r.texts.nextReviewNote}</Text>
      </View>
    </Frame>
  );
}

// ---------------------------------------------------------------------------

/** The pages this client's report has, in order (for the form's table of contents too). */
/** The pages this client's report has, in order (titles as printed). */
export function pagesOf(r: QuarterlyReport): string[] {
  return pageHeads(r).map((p) => (p.key === "cover" ? "Cover" : p.section));
}

export function QuarterlyReviewDocument({ r }: { r: QuarterlyReport }) {
  return (
    <Document title={`Quarterly Review — ${r.client.name} — ${date(r.asOf)}`} author="Univest Wealth" subject={`Quarterly portfolio review · ${r.quarterLabel}`} creator="Univest MF Premium Advisory Desk" producer="Univest Wealth">
      <Cover r={r} />
      <Glance r={r} />
      <Story r={r} />
      <Market r={r} />
      {r.plan.rows.length ? <Plan r={r} /> : null}
      {r.score.rows.length ? <Scorecard r={r} /> : null}
      {r.old ? <OldNew r={r} /> : null}
      <Health r={r} />
      {r.rebalance ? <Rebalance r={r} /> : null}
      <Structure r={r} />
      {r.sip.rows.length ? <Sip r={r} /> : null}
      <Tax r={r} />
      <Projections r={r} />
      <Actions r={r} />
    </Document>
  );
}

export async function renderQuarterlyPdf(r: QuarterlyReport): Promise<Buffer> {
  registerFonts();
  return renderToBuffer(<QuarterlyReviewDocument r={r} />);
}

/** File name for the download: "Univest Quarterly Review - <name> <date>.pdf". */
export function reviewFileName(r: QuarterlyReport): string {
  return `Univest Quarterly Review - ${r.client.name} ${date(r.asOf)}.pdf`.replace(/[\\/:*?"<>|]+/g, "_");
}
