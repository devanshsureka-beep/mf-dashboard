import type { ActionResult } from "@/lib/actions";
import { stageLargeFiles } from "@/lib/stage-files";

/**
 * A server action call that fails in transport (not inside the action, which
 * returns its own ActionResult) used to crash the whole page. The usual cause
 * is a page left open across a deploy: its form IDs no longer exist on the new
 * version and the server answers with something the browser cannot read.
 * This turns that into an inline message; Next's own redirect / not-found
 * signals still pass through. Large files are staged in storage first.
 */
export function transportError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof Error && e.name === "StageError") return msg;
  if (/unexpected response|server action|failed to find/i.test(msg)) {
    return "The app was updated while this page was open, so this form is out of date. Nothing was saved. Reload the page (Ctrl+Shift+R) and submit again.";
  }
  if (/failed to fetch|network|load failed/i.test(msg)) {
    return "Could not reach the server (network). Nothing was saved. Check the connection and submit again.";
  }
  return `The request failed before the server could answer (${msg.slice(0, 160)}). Nothing was saved. Reload the page and submit again.`;
}

function isNextSignal(e: unknown): boolean {
  const d = (e as { digest?: unknown } | null)?.digest;
  return typeof d === "string" && d.startsWith("NEXT_");
}

export function safeAction<A extends unknown[], R extends ActionResult>(action: (...args: A) => Promise<R>) {
  return async (...args: A): Promise<R | { ok: false; error: string }> => {
    try {
      // Large files go straight to storage first (the form then carries their paths).
      for (const a of args) if (a instanceof FormData) await stageLargeFiles(a);
      return await action(...args);
    } catch (e) {
      if (isNextSignal(e)) throw e;
      return { ok: false, error: transportError(e) };
    }
  };
}
