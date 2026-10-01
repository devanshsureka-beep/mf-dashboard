import { afterEach, describe, expect, it, vi } from "vitest";
import { answerToReport, askClaudeForReport, buildReportAiRequest, REPORT_AI_SCHEMA, type ReportAiAnswer } from "@/lib/integrations/report-ai";
import { buildPlanFromReport, type PlanHolding } from "@/lib/domain/report-plan";

const holdings: PlanHolding[] = [
  { scheme_name: "HDFC Flexi Cap Fund - Regular Plan - Growth", isin: "INF179K01BE2", folio_number: "1111/11", current_value: 500000, plan_type: "REGULAR" },
  { scheme_name: "Axis Small Cap Fund - Direct Growth", isin: "INF846K01K35", folio_number: "2222", current_value: 300000, plan_type: "DIRECT" },
  { scheme_name: "Parag Parikh Flexi Cap Fund - Direct Plan Growth", isin: "INF879O01027", folio_number: "3333", current_value: 200000, plan_type: "DIRECT" },
];

const answer: ReportAiAnswer = {
  client_name: "Sample Client", report_cas_date: "2026-09-20", prepared_date: "2026-09-22", portfolio_value: 1000000,
  risk_profile: "Aggressive", goal: null,
  sells: [{ fund: "HDFC Flexi Cap Fund (Regular)", folio: "1111/11", folio_count: 1, plan_type: "REGULAR", partial: false, value: 495000 }],
  sell_total: 495000,
  buys: [
    { fund: "HDFC Flexi Cap Fund", plan_type: "DIRECT", amount: 300000, kind: "NEW", amc: "HDFC", category: "Flexi Cap" },
    { fund: "Axis Small Cap Fund", plan_type: "DIRECT", amount: 195000, kind: "TOP_UP", amc: "Axis", category: "Small Cap" },
  ],
  buy_total: 495000,
  sips: [{ fund: "Parag Parikh Flexi Cap Fund", plan_type: "DIRECT", change: "CHANGE", current: 10000, next: 15000 }],
  holds: [
    { fund: "Axis Small Cap Fund", folio: null, folio_count: 1, plan_type: "DIRECT", value: 298000, deferred: false, note: "Core small-cap" },
    { fund: "Parag Parikh Flexi Cap", folio: null, folio_count: 1, plan_type: "DIRECT", value: null, deferred: false, note: null },
  ],
  corrections: ["Added the HDFC Flexi Cap exit the reader missed."],
};

describe("Claude's answer goes through the same CAS tie-out", () => {
  it("becomes a report every check understands, and a clean answer ties out", () => {
    const report = answerToReport(answer, null);
    expect(report.template).toBe("AI_ASSISTED");
    expect(report.problems).toEqual([]);
    expect(report.mentioned.map((m) => m.fund)).toEqual(["Parag Parikh Flexi Cap"]);
    expect(report.deploymentNotes.join(" ")).toMatch(/Claude's help.*HDFC Flexi Cap exit/);
    const plan = buildPlanFromReport(report, holdings, "2026-09-23");
    expect(plan.problems).toEqual([]);
    expect(plan.items.find((i) => i.action === "SELL")).toMatchObject({ isin: "INF179K01BE2", target_amount: 500000 });
    expect(plan.items.find((i) => i.action === "RETAIN" && i.isin === "INF846K01K35")?.reason).toMatch(/Core small-cap/);
  });

  it("an invented line or wrong total is still caught", () => {
    const invented = answerToReport({ ...answer, sells: [...answer.sells, { fund: "Quant Active Fund", folio: null, folio_count: 1, plan_type: "DIRECT", partial: false, value: 100000 }] }, null);
    expect(invented.problems[0]).toMatch(/sell lines add up to ₹5,95,000.*₹4,95,000/);
    const plan = buildPlanFromReport(invented, holdings, "2026-09-23");
    expect(plan.problems.some((p) => /Quant Active/.test(p))).toBe(true);
    // A CAS fund the answer leaves out is not covered.
    const missing = buildPlanFromReport(answerToReport({ ...answer, holds: [] }, null), holdings, "2026-09-23");
    expect(missing.problems.some((p) => /Axis Small Cap .* not covered/.test(p))).toBe(false); // top-up covers it
    expect(missing.problems.some((p) => /Parag Parikh .* not covered/.test(p))).toBe(false); // SIP change covers it
  });

  it("asks for strict JSON: every object closed and every field required", () => {
    const walk = (s: Record<string, unknown>): void => {
      if (s.type === "object") {
        expect(s.additionalProperties).toBe(false);
        expect(s.required).toEqual(Object.keys(s.properties as object));
        Object.values(s.properties as Record<string, Record<string, unknown>>).forEach(walk);
      }
      if (s.type === "array") walk(s.items as Record<string, unknown>);
      if (s.anyOf) (s.anyOf as Record<string, unknown>[]).forEach(walk);
    };
    walk(REPORT_AI_SCHEMA as Record<string, unknown>);
    const req = buildReportAiRequest({ pdf: new Uint8Array([37, 80, 68, 70]), holdings, casValuationDate: "2026-09-23", draft: null, readerError: "unknown layout", problems: [] });
    expect(req.model).toBe("claude-opus-5-5");
    expect(req.messages[0].content[0]).toMatchObject({ type: "document", source: { media_type: "application/pdf", data: "JVBERg==" } });
    expect(req.messages[0].content[1].text).toContain("unknown layout");
  });
});

describe("calling Claude through n8n", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  const input = { pdf: new Uint8Array([1]), holdings, casValuationDate: null, draft: null, readerError: null, problems: [] };

  it("sends the key header, unwraps n8n's reply and validates the JSON", async () => {
    vi.stubEnv("REPORT_AI_URL", "https://n8n.example/webhook/x");
    vi.stubEnv("REPORT_AI_KEY", "k");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 200, body: { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(answer) }] } })));
    vi.stubGlobal("fetch", fetchMock);
    const out = await askClaudeForReport(input);
    expect(out.report.sells).toHaveLength(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["x-desk-key"]).toBe("k");
  });

  it("explains failures in plain words", async () => {
    vi.stubEnv("REPORT_AI_URL", "https://n8n.example/webhook/x");
    vi.stubEnv("REPORT_AI_KEY", "k");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 403 })));
    await expect(askClaudeForReport(input)).rejects.toThrow(/refused the key/);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: 200, body: { stop_reason: "end_turn", content: [{ type: "text", text: "{\"sells\": 1}" }] } }))));
    await expect(askClaudeForReport(input)).rejects.toThrow(/expected shape/);
    vi.unstubAllEnvs();
    vi.stubEnv("REPORT_AI_URL", "");
    await expect(askClaudeForReport(input)).rejects.toThrow(/not set up/);
  });
});
