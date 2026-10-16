/**
 * The CAS reader's warnings, said as what a person has to look at.
 *
 * The reader writes one warning per check it could not pass ("ISIN for folio … could not be read
 * with a valid check digit.", "…: ISIN missing — security matched by name only."). Several of them
 * are about the same fund; the review screen shows one point per fund, in plain words, with the
 * fund it was matched to. Pure: no DB, no Next.js.
 */

export type ReviewKind = "FUND_MATCH" | "UNITS" | "TOTAL" | "PAN" | "FAMILY" | "DUPLICATE" | "OTHER";

export interface ReviewPoint {
  kind: ReviewKind;
  /** The question, e.g. "Is this the right fund?" */
  title: string;
  /** What we read and what we did with it. */
  detail: string;
  /** "blocked": it may be the wrong CAS or wrong numbers; "review": a look is enough. */
  severity: "review" | "blocked";
  scheme?: string;
  folio?: string;
}

export interface ReviewHolding {
  scheme_name: string;
  folio_number: string | null;
  isin: string | null;
  /** The fund it was matched to in our fund list (null: not matched). */
  matched_name: string | null;
  units: number;
  current_value: number;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const folioKey = (f: string | null | undefined) => (f ?? "").split("/")[0].replace(/[^0-9a-z]/gi, "").toLowerCase();
/** Never print a full PAN on screen: "ABCDE1234F" → "••••••234F". */
export const maskPan = (pan: string) => (pan.length > 4 ? `${"•".repeat(pan.length - 4)}${pan.slice(-4)}` : pan);
/**
 * Mask every PAN in a reader message, also a misread one: in a line that speaks of a PAN, any
 * token of 6-12 letters and digits mixed is treated as one. Folio numbers (digits only) stay.
 */
export function maskPans(s: string): string {
  if (!/\bPAN/i.test(s)) return s.replace(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/g, maskPan);
  return s.replace(/\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{6,12}\b/g, (t) => (t === "PAN" ? t : maskPan(t)));
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

/** One point per fund for the fund-code warnings; every other warning as its own point. */
export function explainCasWarnings(warnings: readonly string[], holdings: readonly ReviewHolding[] = []): ReviewPoint[] {
  const out: ReviewPoint[] = [];
  const fundPoints = new Map<string, ReviewPoint>();
  // One folio can hold several funds: match by fund name (and folio when both are known); a folio
  // alone only when that folio holds a single fund.
  const holdingFor = (scheme?: string, folio?: string) => {
    const byName = scheme ? holdings.filter((h) => norm(h.scheme_name) === norm(scheme)) : [];
    if (byName.length) return (folio && byName.find((h) => folioKey(h.folio_number) === folioKey(folio))) || byName[0];
    const inFolio = folio ? holdings.filter((h) => folioKey(h.folio_number) === folioKey(folio)) : [];
    return !scheme && inFolio.length === 1 ? inFolio[0] : null;
  };

  const fundPoint = (scheme: string | undefined, folio: string | undefined, why: string) => {
    const h = holdingFor(scheme, folio);
    const name = scheme || h?.scheme_name || "a fund";
    const key = h ? `${folioKey(h.folio_number)}|${norm(h.scheme_name)}` : `${folioKey(folio)}|${norm(name)}`;
    const existing = fundPoints.get(key);
    if (existing) {
      if (!existing.folio && folio) existing.folio = folio;
      return;
    }
    const where = folio ?? h?.folio_number ?? null;
    const match = h?.matched_name
      ? `We matched it by name to ${h.matched_name}.`
      : "We could not match it to a fund in our list, so it counts by its name only.";
    const size = h ? ` ${h.units.toLocaleString("en-IN", { maximumFractionDigits: 3 })} units, ${inr(h.current_value)}.` : "";
    const p: ReviewPoint = {
      kind: "FUND_MATCH",
      title: "Is this the right fund?",
      detail: `${why}${where ? ` (folio ${where})` : ""}. ${match}${size}`,
      severity: "review",
      scheme: name,
      folio: where ?? undefined,
    };
    fundPoints.set(key, p);
    out.push(p);
  };

  for (const raw of warnings) {
    const w = raw.trim();
    let m: RegExpMatchArray | null;
    if ((m = w.match(/^ISIN for folio (.+?) \((.*)\) could not be read with a valid check digit\.?$/))) {
      fundPoint(m[2] === "unknown scheme" ? undefined : m[2], m[1], `The fund code of ${m[2] === "unknown scheme" ? "a fund" : m[2]} is smudged on the PDF`);
    } else if ((m = w.match(/^ISIN not found for folio (.+?) \((.*)\)\.?$/))) {
      fundPoint(m[2] === "unknown scheme" ? undefined : m[2], m[1], `The PDF shows no fund code for ${m[2] === "unknown scheme" ? "a fund" : m[2]}`);
    } else if ((m = w.match(/^(.+): ISIN missing — security matched by name only\.?$/))) {
      fundPoint(m[1], undefined, `The PDF shows no fund code for ${m[1]}`);
    } else if ((m = w.match(/^(.+) \((.+)\): last transaction balance (.+) ≠ closing units (.+)\.$/))) {
      out.push({ kind: "UNITS", title: "Do the units add up?", severity: "review", scheme: m[1], folio: m[2],
        detail: `${m[1]} (folio ${m[2]}): the last transaction leaves ${m[3]} units, but the closing balance says ${m[4]}. Check the units on the PDF.` });
    } else if ((m = w.match(/^(.+) \((.+)\): units × NAV ≠ market value\.$/)) || (m = w.match(/^(.+): units × NAV \((.+)\) does not match value \((.+)\)\.$/))) {
      out.push({ kind: "UNITS", title: "Does the value add up?", severity: "review", scheme: m[1],
        detail: m[3] ? `${m[1]}: units × NAV comes to ${m[2]}, but the value printed is ${m[3]}.` : `${m[1]} (folio ${m[2]}): units × NAV is not the value printed.` });
    } else if ((m = w.match(/^(?:Holdings|Scheme values) add up to (₹[\d,.]+) but the (?:statement total|portfolio summary says) (?:is )?(₹[\d,.]+)\.$/))) {
      out.push({ kind: "TOTAL", title: "Does the total match?", severity: "blocked",
        detail: `The funds we read add up to ${m[1]}, but the PDF's total is ${m[2]}. A fund may be missing or read twice.` });
    } else if ((m = w.match(/^Statement PAN (\S+) does not match the client's PAN (\S+?)\.?$/))) {
      out.push({ kind: "PAN", title: "Is this the right client?", severity: "blocked",
        detail: `The PAN on this CAS (${maskPan(m[1])}) is not the client's PAN (${maskPan(m[2])}). It may be someone else's CAS.` });
    } else if (/^This CAS also contains folios of other PAN/.test(w)) {
      out.push({ kind: "FAMILY", title: "Family folios inside", severity: "review",
        detail: `${maskPans(w.replace(/ \(family consolidation\)\.?$/, ""))}. Check that only this client's funds are counted.` });
    } else if (/possible duplicate statement/.test(w)) {
      out.push({ kind: "DUPLICATE", title: "Already uploaded?", severity: "blocked",
        detail: "A CAS with the same date and the same total is already here. If it is the same file, reject this one." });
    } else {
      out.push({ kind: "OTHER", title: "Check on the PDF", severity: "review", detail: maskPans(w) });
    }
  }
  return out;
}

/** True when the reader's total matched the statement (no TOTAL point). */
export const totalMatches = (points: readonly ReviewPoint[]) => !points.some((p) => p.kind === "TOTAL");
