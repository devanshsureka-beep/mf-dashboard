/**
 * Fuzzy helpers for messy fund names (pure). Used to SUGGEST security matches
 * for extracted documents; a person confirms unresolved suggestions.
 */

const STOP_WORDS = new Set(["fund", "the", "of", "and", "plan", "option", "scheme", "growth", "india", "ltd", "mf"]);

export function tokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/\bfof\b/g, "fund of funds")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t && !STOP_WORDS.has(t));
}

/** Dice coefficient over name tokens (0..1). */
export function nameSimilarity(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return (2 * common) / (ta.size + tb.size);
}

export function detectPlanType(name: string): "DIRECT" | "REGULAR" | null {
  const n = name.toLowerCase();
  if (/\bdirect\b|\bdir\b|\(dir\)/.test(n)) return "DIRECT";
  if (/\bregular\b|\breg\b|\(reg\)/.test(n)) return "REGULAR";
  return null;
}

export interface SecurityCandidate {
  id: string;
  scheme_name: string;
  isin: string | null;
  plan_type: string | null;
  aliases?: string[] | null;
}

/**
 * Best candidate for a free-text scheme name. Returns `confident` only when the
 * top score is high AND clearly ahead of the runner-up AND plan types agree.
 */
export function bestSecurityMatch(
  name: string,
  candidates: SecurityCandidate[],
): { candidate: SecurityCandidate | null; score: number; confident: boolean } {
  const wantPlan = detectPlanType(name);
  const scored = candidates
    .map((c) => {
      const names = [c.scheme_name, ...(c.aliases ?? [])];
      let score = Math.max(...names.map((n) => nameSimilarity(name, n)));
      if (wantPlan && c.plan_type && c.plan_type !== wantPlan) score -= 0.3;
      return { c, score };
    })
    .sort((a, b) => b.score - a.score);
  const top = scored[0];
  if (!top) return { candidate: null, score: 0, confident: false };
  const second = scored[1]?.score ?? 0;
  const confident = top.score >= 0.85 && top.score - second >= 0.1;
  return { candidate: top.score >= 0.5 ? top.c : null, score: top.score, confident };
}
