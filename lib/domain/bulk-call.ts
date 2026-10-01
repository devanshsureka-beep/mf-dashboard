/**
 * One call for many clients: how much each client is told (pure).
 *
 *  FIXED            the same rupee amount for everyone
 *  PCT_MONEY_LEFT   % of the money left with the client after executed calls
 *  PCT_PORTFOLIO    % of the client's portfolio value today
 *  PCT_HOLDING      % of the client's current holding in the chosen fund (sells)
 *
 * Amounts are rounded down to ₹100; anything under the minimum is skipped with
 * a reason, never sent as a tiny call.
 */
export type BulkMode = "FIXED" | "PCT_MONEY_LEFT" | "PCT_PORTFOLIO" | "PCT_HOLDING";

export const BULK_MODES: { value: BulkMode; label: string }[] = [
  { value: "FIXED", label: "Same ₹ amount for each client" },
  { value: "PCT_MONEY_LEFT", label: "% of money left with the client" },
  { value: "PCT_PORTFOLIO", label: "% of portfolio value today" },
  { value: "PCT_HOLDING", label: "% of the client's holding in this fund" },
];

export const MIN_CALL = 500;

export interface BulkClientFigures { money_left: number; live_value: number; holding_value: number | null }

export type BulkAmount = { amount: number } | { skip: string };

export function bulkAmount(mode: BulkMode, value: number, c: BulkClientFigures, action: "BUY" | "SELL"): BulkAmount {
  if (!(value > 0)) return { skip: "No amount / percentage entered" };
  if (mode !== "FIXED" && value > 100) return { skip: "Percentage above 100%" };
  let raw: number;
  switch (mode) {
    case "FIXED": raw = value; break;
    case "PCT_MONEY_LEFT": raw = (Math.max(c.money_left, 0) * value) / 100; break;
    case "PCT_PORTFOLIO": raw = (Math.max(c.live_value, 0) * value) / 100; break;
    case "PCT_HOLDING":
      if (!c.holding_value) return { skip: "Does not hold this fund" };
      raw = (c.holding_value * value) / 100;
      break;
  }
  if (action === "SELL" && c.holding_value != null && raw > c.holding_value + 1) {
    return { skip: `Sell exceeds the holding (₹${Math.round(c.holding_value).toLocaleString("en-IN")})` };
  }
  if (action === "SELL" && c.holding_value == null) return { skip: "Does not hold this fund" };
  const amount = mode === "FIXED" ? Math.round(raw * 100) / 100 : Math.floor(raw / 100) * 100;
  if (amount < MIN_CALL) return { skip: `Works out below ₹${MIN_CALL}` };
  return { amount };
}
