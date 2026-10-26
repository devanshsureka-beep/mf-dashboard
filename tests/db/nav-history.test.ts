import { afterAll, describe, expect, it } from "vitest";
import { ingestNavFeed } from "@/services/nav";
import { codesToFetch, ensureNavHistory, navSeries, type Fetcher } from "@/services/nav-history";
import { scenario, sql, TEST_DB } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});

const body = (code: string, rows: [string, number][]) =>
  JSON.stringify({ meta: { scheme_code: Number(code) }, data: rows.map(([date, nav]) => ({ date, nav: String(nav) })) });

describeDb("NAV history", () => {
  it("fetches once, stores, logs failures, and the daily feed keeps tracked codes current", async () => {
    await scenario(async (ctx) => {
      const calls: string[] = [];
      const fetcher: Fetcher = async (url) => {
        const code = String(url).split("/").pop()!;
        calls.push(code);
        if (code === "900002") return new Response("down", { status: 502 });
        return new Response(body(code, [["01-01-2026", 100], ["01-06-2026", 110], ["09-10-2026", 120]]), { status: 200 });
      };
      const write = <T,>(fn: (tx: typeof ctx.tx) => Promise<T>) => ctx.as("advisor", fn);
      const r = await ensureNavHistory(write, ["900001", "900002"], "2026-01-01", "2026-10-09", fetcher);
      expect(r).toEqual({ fetched: ["900001"], failed: ["900002"] });

      const series = await ctx.as("advisor", (t) => navSeries(t, ["900001"], "2026-01-01", "2026-12-31"));
      expect(series.get("900001")).toEqual([{ date: "2026-01-01", nav: 100 }, { date: "2026-06-01", nav: 110 }, { date: "2026-10-09", nav: 120 }]);
      // Covered: not fetched again. The failure is not retried within the hour.
      expect(await ctx.as("advisor", (t) => codesToFetch(t, ["900001", "900002"], "2026-01-01", "2026-10-09"))).toEqual([]);
      // Needing older history than stored asks for it again only after the fetch goes stale.
      expect(await ctx.as("advisor", (t) => codesToFetch(t, ["900001"], "2020-01-01", "2026-10-09"))).toEqual([]);

      // Daily feed: today's NAV for a tracked code lands in the history.
      await ctx.asSuper((t) => ingestNavFeed(t, { navDate: "2026-10-12", schemes: [
        { isin: "INF000Q01001", amfi_code: "900001", scheme_name: "Q Fund - Direct Plan - Growth", amc: null, category: null, plan_type: "DIRECT", option_type: "GROWTH", nav: 121.5, nav_date: "2026-10-12" },
        { isin: "INF000Q01027", amfi_code: "119063", scheme_name: "Benchmark Nifty 50 Index - Direct Plan - Growth", amc: null, category: null, plan_type: "DIRECT", option_type: "GROWTH", nav: 250, nav_date: "2026-10-12" },
        { isin: "INF000Q01019", amfi_code: "900003", scheme_name: "Untracked - Direct Plan - Growth", amc: null, category: null, plan_type: "DIRECT", option_type: "GROWTH", nav: 50, nav_date: "2026-10-12" },
      ] }, "test"));
      const after = await ctx.as("advisor", (t) => navSeries(t, ["900001", "900003"], "2026-10-10", "2026-12-31"));
      expect(after.get("900001")).toEqual([{ date: "2026-10-12", nav: 121.5 }]);
      expect(after.get("900003")).toBeUndefined();
      // Benchmark index funds build history from the feed even if never fetched.
      expect((await ctx.as("advisor", (t) => navSeries(t, ["119063"], "2026-10-12", "2026-10-12"))).get("119063")).toEqual([{ date: "2026-10-12", nav: expect.any(Number) }]);
      expect(calls.sort()).toEqual(["900001", "900002"]);
    });
  });
});
