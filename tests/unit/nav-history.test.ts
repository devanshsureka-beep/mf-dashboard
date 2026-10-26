import { describe, expect, it } from "vitest";
import { parseNavHistory } from "@/lib/parsers/nav-history";
import { downloadNavHistory, type Fetcher } from "@/services/nav-history";

// Made-up NAVs in the mfapi.in shape.
const BODY = {
  meta: { scheme_code: 119063, scheme_name: "Sample Nifty 50 Index Fund - Direct Plan - Growth" },
  data: [
    { date: "13-10-2026", nav: "250.1200" },
    { date: "12-10-2026", nav: "248.5000" },
    { date: "12-10-2026", nav: "248.5000" },
    { date: "31-02-2026", nav: "240.0000" },
    { date: "09-10-2026", nav: "N.A." },
    { date: "08-10-2026", nav: "0" },
    { date: "07-10-2026", nav: "1,201.5" },
  ],
  status: "SUCCESS",
};

describe("NAV history", () => {
  it("reads one NAV per date, oldest first, skipping bad dates and NAVs", () => {
    const p = parseNavHistory(BODY);
    expect(p.code).toBe("119063");
    expect(p.points).toEqual([
      { date: "2026-10-07", nav: 1201.5 },
      { date: "2026-10-12", nav: 248.5 },
      { date: "2026-10-13", nav: 250.12 },
    ]);
  });

  it("rejects an unexpected body", () => {
    expect(() => parseNavHistory({ error: "no" })).toThrow(/unexpected/);
  });

  it("downloads from the history URL and checks the scheme", async () => {
    const urls: string[] = [];
    const ok: Fetcher = async (url) => { urls.push(String(url)); return new Response(JSON.stringify(BODY), { status: 200 }); };
    expect(await downloadNavHistory("119063", ok)).toHaveLength(3);
    expect(urls).toEqual(["https://api.mfapi.in/mf/119063"]);
    await expect(downloadNavHistory("120716", ok)).rejects.toThrow(/another scheme/);
    const down: Fetcher = async () => new Response("busy", { status: 503 });
    await expect(downloadNavHistory("119063", down)).rejects.toThrow(/HTTP 503/);
    await expect(downloadNavHistory("12x", ok)).rejects.toThrow(/bad AMFI code/);
  });
});
