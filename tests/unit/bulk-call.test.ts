import { describe, expect, it } from "vitest";
import { bulkAmount } from "@/lib/domain/bulk-call";

const c = { money_left: 1250000, live_value: 7400000, holding_value: 1700000 };

describe("bulk call amounts", () => {
  it("fixed amount for everyone", () => {
    expect(bulkAmount("FIXED", 200000, c, "BUY")).toEqual({ amount: 200000 });
  });
  it("percent of money left / portfolio / holding, rounded down to ₹100", () => {
    expect(bulkAmount("PCT_MONEY_LEFT", 40, c, "BUY")).toEqual({ amount: 500000 });
    expect(bulkAmount("PCT_PORTFOLIO", 3.33, c, "BUY")).toEqual({ amount: 246400 });
    expect(bulkAmount("PCT_HOLDING", 25, c, "SELL")).toEqual({ amount: 425000 });
  });
  it("skips clients it cannot apply to, with the reason", () => {
    expect(bulkAmount("PCT_MONEY_LEFT", 50, { ...c, money_left: 0 }, "BUY")).toEqual({ skip: "Works out below ₹500" });
    expect(bulkAmount("PCT_HOLDING", 50, { ...c, holding_value: null }, "SELL")).toEqual({ skip: "Does not hold this fund" });
    expect(bulkAmount("FIXED", 100000, { ...c, holding_value: null }, "SELL")).toEqual({ skip: "Does not hold this fund" });
    expect(bulkAmount("FIXED", 2000000, c, "SELL")).toMatchObject({ skip: expect.stringContaining("exceeds the holding") });
    expect(bulkAmount("PCT_PORTFOLIO", 150, c, "BUY")).toEqual({ skip: "Percentage above 100%" });
    expect(bulkAmount("FIXED", 0, c, "BUY")).toEqual({ skip: "No amount / percentage entered" });
  });
});
