/**
 * Pure business rules for advice items (unit-tested). The database enforces
 * the same invariants; these give early, friendly validation errors.
 */

export interface AdviceQuantities {
  quantityBasis: "AMOUNT" | "UNITS";
  advisedAmount: number;
  advisedUnits: number | null;
  executedAmount: number;
  executedUnits: number;
}

/** Tolerance within which an AMOUNT-basis call is considered fully executed. */
export const AMOUNT_TOLERANCE = 0.01;
/** Executions may exceed the advised quantity by at most this much without explicit override. */
export const OVER_EXECUTION_LIMIT = 0.1;

/**
 * Revising a call: the advisor states the NEW TOTAL for the call. Whatever was
 * already executed against the original stays with the original item; the
 * replacement item carries only the remainder, so nothing is double counted.
 */
export function revisionRemainder(
  original: AdviceQuantities,
  newTotal: { amount: number; units?: number | null },
): { amount: number; units: number | null } {
  const amount = round2(newTotal.amount - original.executedAmount);
  if (amount <= 0) {
    throw new Error(
      `New total (₹${newTotal.amount.toLocaleString("en-IN")}) must be greater than the amount already executed ` +
        `(₹${original.executedAmount.toLocaleString("en-IN")}). Cancel the remaining quantity instead.`,
    );
  }
  let units: number | null = null;
  if (original.quantityBasis === "UNITS") {
    if (!newTotal.units || newTotal.units <= 0) throw new Error("New total units are required for a unit-based call.");
    units = round4(newTotal.units - original.executedUnits);
    if (units <= 0) throw new Error("New total units must exceed units already executed.");
  }
  return { amount, units };
}

/** Would recording this execution exceed the call by more than the allowed limit? */
export function overExecution(
  advice: AdviceQuantities,
  add: { amount: number; units?: number | null },
): { exceeds: boolean; message: string | null } {
  if (advice.quantityBasis === "UNITS" && advice.advisedUnits) {
    const total = advice.executedUnits + (add.units ?? 0);
    if (total > advice.advisedUnits * (1 + OVER_EXECUTION_LIMIT)) {
      return { exceeds: true, message: `Executed units (${round4(total)}) would exceed advised units (${advice.advisedUnits}) by more than 10%.` };
    }
    return { exceeds: false, message: null };
  }
  const total = advice.executedAmount + add.amount;
  if (total > advice.advisedAmount * (1 + OVER_EXECUTION_LIMIT)) {
    return {
      exceeds: true,
      message: `Executed amount (₹${Math.round(total).toLocaleString("en-IN")}) would exceed the advised ₹${Math.round(advice.advisedAmount).toLocaleString("en-IN")} by more than 10%.`,
    };
  }
  return { exceeds: false, message: null };
}

/** Mirror of the DB status derivation (app.refresh_advice_item_status). */
export function deriveAdviceStatus(q: AdviceQuantities): "ISSUED" | "PARTIALLY_EXECUTED" | "EXECUTED" {
  if (q.quantityBasis === "UNITS" && q.advisedUnits) {
    if (q.executedUnits >= q.advisedUnits - 0.001) return "EXECUTED";
    return q.executedUnits > 0 || q.executedAmount > 0 ? "PARTIALLY_EXECUTED" : "ISSUED";
  }
  if (q.executedAmount >= q.advisedAmount * (1 - AMOUNT_TOLERANCE)) return "EXECUTED";
  return q.executedAmount > 0 || q.executedUnits > 0 ? "PARTIALLY_EXECUTED" : "ISSUED";
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
