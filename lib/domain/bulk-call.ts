/**
 * One call for many clients: how much each client is told (pure).
 *
 *  PLAN             what each client's active plan still has to advise for this fund (and side)
 *  FIXED            the same rupee amount for everyone
 *  PCT_CASH         % of the client's cash in bank (sold, not bought back, plus fresh money)
 *  PCT_MONEY_LEFT   % of the money left with the client after executed calls
 *  PCT_PORTFOLIO    % of the client's portfolio value today
 *  PCT_HOLDING      % of the client's current holding in the chosen fund (sells)
 *
 * Amounts are rounded down to ₹100; anything under the minimum is skipped with
 * a reason, never sent as a tiny call.
 */
export type BulkMode = "PLAN" | "FIXED" | "PCT_CASH" | "PCT_MONEY_LEFT" | "PCT_PORTFOLIO" | "PCT_HOLDING";

export const BULK_MODES: { value: BulkMode; label: string }[] = [
  { value: "PLAN", label: "As each client's plan says" },
  { value: "FIXED", label: "Same ₹ amount for each client" },
  { value: "PCT_CASH", label: "% of each client's cash" },
  { value: "PCT_MONEY_LEFT", label: "% of money left with the client" },
  { value: "PCT_PORTFOLIO", label: "% of portfolio value today" },
  { value: "PCT_HOLDING", label: "% of the client's holding in this fund" },
];

export const MIN_CALL = 500;

export interface BulkClientFigures {
  money_left: number;
  live_value: number;
  holding_value: number | null;
  /** Cash in bank (v_client_bank). */
  cash?: number;
  /** The client's plan line for this fund and side: what is left to advise (null: no such line). */
  plan_left?: number | null;
}

export type BulkAmount = { amount: number } | { skip: string };

export function bulkAmount(mode: BulkMode, value: number, c: BulkClientFigures, action: "BUY" | "SELL"): BulkAmount {
  if (mode !== "PLAN" && !(value > 0)) return { skip: "No amount / percentage entered" };
  if (mode !== "FIXED" && mode !== "PLAN" && value > 100) return { skip: "Percentage above 100%" };
  let raw: number;
  switch (mode) {
    case "PLAN":
      if (c.plan_left == null) return { skip: "No plan line for this fund" };
      if (c.plan_left < 0.5) return { skip: "Plan line already fully advised" };
      raw = c.plan_left;
      break;
    case "PCT_CASH": raw = (Math.max(c.cash ?? 0, 0) * value) / 100; break;
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
  const amount = mode === "FIXED" || mode === "PLAN" ? Math.round(raw * 100) / 100 : Math.floor(raw / 100) * 100;
  if (amount < MIN_CALL) return { skip: `Works out below ₹${MIN_CALL}` };
  return { amount };
}
