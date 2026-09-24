/**
 * Errors safe to show to users. Anything else is logged server-side and shown
 * as a generic message (no stack traces / SQL leak to the browser).
 */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: "VALIDATION" | "NOT_FOUND" | "FORBIDDEN" | "CONFLICT" | "CONFIG" = "VALIDATION",
  ) {
    super(message);
    this.name = "AppError";
  }
}

interface PgLikeError {
  code?: string;
  message?: string;
  detail?: string;
  constraint_name?: string;
}

function isPgError(e: unknown): e is PgLikeError {
  return typeof e === "object" && e !== null && "code" in e && typeof (e as PgLikeError).code === "string";
}

/** Translate an unknown error into a message suitable for the UI. */
export function toUserMessage(e: unknown): string {
  if (e instanceof AppError) return e.message;
  if (isPgError(e)) {
    const msg = e.message ?? "";
    if (msg.includes("row-level security")) return "You do not have permission to perform this action.";
    switch (e.code) {
      case "42501": // insufficient privilege / immutable-field guard
      case "23514": // check violation / reason required
      case "P0001": // raise exception from business-rule triggers
        return msg;
      case "23505":
        if (e.constraint_name?.includes("dedupe")) return "This document has already been uploaded for this client.";
        if (e.constraint_name?.includes("one_active")) return "The client already has an ACTIVE plan.";
        return "A record with the same identifying details already exists.";
      case "23503":
        return "A referenced record does not exist.";
      case "22P02":
        return "Invalid identifier or value.";
    }
  }
  return "Something went wrong. The error has been logged.";
}

export function logServerError(context: string, e: unknown): void {
  // Never log request bodies here: they may contain CAS passwords or PII.
  const code = isPgError(e) ? e.code : undefined;
  const message = e instanceof Error ? e.message : String(e);
  console.error(`[${context}]`, code ? `pg:${code}` : "", message);
}
