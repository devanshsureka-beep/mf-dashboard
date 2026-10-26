/**
 * Past NAVs of one scheme, as served by api.mfapi.in (a mirror of AMFI's NAV
 * history): { meta: { scheme_code }, data: [{ date: "dd-mm-yyyy", nav: "123.45" }] }.
 * Pure; no network. Rows with a bad date or a NAV that is not a positive number are
 * skipped; the result is sorted by date, one NAV per date.
 */
import { z } from "zod";

export interface NavPoint { date: string; nav: number }

const Feed = z.object({
  meta: z.object({ scheme_code: z.union([z.number(), z.string()]) }).passthrough(),
  data: z.array(z.object({ date: z.string(), nav: z.union([z.string(), z.number()]) }).passthrough()),
}).passthrough();

const DMY = /^(\d{2})-(\d{2})-(\d{4})$/;

function isoOf(dmy: string): string | null {
  const m = DMY.exec(dmy.trim());
  if (!m) return null;
  const [, d, mo, y] = m;
  const t = Date.UTC(Number(y), Number(mo) - 1, Number(d));
  const dt = new Date(t);
  if (dt.getUTCDate() !== Number(d) || dt.getUTCMonth() !== Number(mo) - 1) return null;
  return `${y}-${mo}-${d}`;
}

export function parseNavHistory(json: unknown): { code: string; points: NavPoint[] } {
  const f = Feed.safeParse(json);
  if (!f.success) throw new Error("NAV history: unexpected response shape");
  const byDate = new Map<string, number>();
  for (const r of f.data.data) {
    const date = isoOf(r.date);
    const nav = typeof r.nav === "number" ? r.nav : Number(String(r.nav).replace(/,/g, ""));
    if (!date || !Number.isFinite(nav) || nav <= 0) continue;
    byDate.set(date, nav);
  }
  const points = [...byDate].map(([date, nav]) => ({ date, nav })).sort((a, b) => a.date.localeCompare(b.date));
  return { code: String(f.data.meta.scheme_code), points };
}
