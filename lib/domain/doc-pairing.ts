/**
 * Bulk onboarding: pair each CAS with its advisory report when every file sits
 * in one folder with no naming rule. A pair is made on the client name inside
 * the files (CAS investor name vs report client name), falling back to the
 * report's file name. Pure; unpaired files are left for a person to pair.
 */

const NOISE = new Set([
  "cas", "report", "advisory", "rebalancing", "rebalance", "final", "pdf", "mf", "mutual", "fund", "funds", "portfolio",
  "review", "plan", "univest", "premium", "statement", "consolidated", "detailed", "summary", "copy", "of", "for", "and",
  "the", "mr", "mrs", "ms", "dr", "shri", "smt", "kumari", "new", "latest", "v1", "v2", "updated", "client",
]);

export function personTokens(s: string | null | undefined): string[] {
  return (s ?? "")
    .toLowerCase()
    .replace(/\.pdf$/i, "")
    .split(/[^a-z]+/)
    .filter((t) => t.length >= 2 && !NOISE.has(t));
}

/** Share of the shorter name's words found in the other (0..1); needs one word of 3+ letters in common. */
export function nameScore(a: string | null | undefined, b: string | null | undefined): number {
  const x = [...new Set(personTokens(a))];
  const y = new Set(personTokens(b));
  if (!x.length || !y.size) return 0;
  const common = x.filter((t) => y.has(t));
  if (!common.some((t) => t.length >= 3)) return 0;
  return common.length / Math.min(x.length, y.size);
}

export interface PairCas { id: string; investorName: string | null; fileName: string }
export interface PairReport { id: string; clientName: string | null; fileName: string }
export interface Pairing { casId: string; reportId: string | null; score: number }

/** A shared surname alone (1 of 2 words) is not enough to pair. */
export const PAIR_THRESHOLD = 0.6;

/** Best pairs first; each file is used once. */
export function pairDocuments(cas: PairCas[], reports: PairReport[]): Pairing[] {
  const scored: { c: PairCas; r: PairReport; score: number }[] = [];
  for (const c of cas) {
    for (const r of reports) {
      const byContent = nameScore(c.investorName, r.clientName);
      const byFile = nameScore(c.investorName, r.fileName) * 0.9;
      const score = Math.max(byContent, byFile);
      if (score >= PAIR_THRESHOLD) scored.push({ c, r, score });
    }
  }
  scored.sort((p, q) => q.score - p.score);
  const usedCas = new Set<string>();
  const usedReport = new Set<string>();
  const out = new Map<string, Pairing>();
  for (const s of scored) {
    if (usedCas.has(s.c.id) || usedReport.has(s.r.id)) continue;
    usedCas.add(s.c.id);
    usedReport.add(s.r.id);
    out.set(s.c.id, { casId: s.c.id, reportId: s.r.id, score: Math.round(s.score * 100) / 100 });
  }
  return cas.map((c) => out.get(c.id) ?? { casId: c.id, reportId: null, score: 0 });
}
