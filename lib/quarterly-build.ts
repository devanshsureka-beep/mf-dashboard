import "server-only";
import { withSystemTx, withUserTx, type Actor } from "@/lib/db/tx";
import { buildQuarterlyReport, type QuarterlyReport } from "@/lib/domain/quarterly-report";
import { codesToFetch, ensureNavHistory } from "@/services/nav-history";
import { gatherReview, getQuarterContext, navNeeds, otherClientNames, type QuarterContext } from "@/services/quarterly-review";

/**
 * A client's quarterly review, ready to lay out. With `fetchNavs`, past NAVs that are missing are
 * downloaded first (up to a minute the first time for a client; then the daily feed keeps them current).
 * Other clients' names (for the check that none appear in the PDF) are read as the server:
 * advisors cannot see other advisors' clients.
 */
export async function buildReviewFor(actor: Actor, clientId: string, quarterEnd: string, opts: { fetchNavs: boolean }): Promise<{ report: QuarterlyReport; generated: QuarterlyReport; context: QuarterContext; navMissing: number }> {
  const needs = await withUserTx(actor, (tx) => navNeeds(tx, clientId, quarterEnd));
  let failed: string[] = [];
  if (opts.fetchNavs) {
    const r = await ensureNavHistory((fn) => withUserTx(actor, fn), needs.codes, needs.from, needs.to);
    failed = r.failed;
  }
  const navMissing = opts.fetchNavs ? failed.length : (await withUserTx(actor, (tx) => codesToFetch(tx, needs.codes, needs.from, needs.to))).length;
  const names = await withSystemTx("quarterly review: name check", (tx) => otherClientNames(tx, clientId));
  const { raw, context } = await withUserTx(actor, async (tx) => ({
    raw: await gatherReview(tx, clientId, quarterEnd, { otherClientNames: names, navFailed: failed }),
    context: await getQuarterContext(tx, clientId, quarterEnd),
  }));
  // `generated`: the same review with nothing typed in, for the form's placeholders.
  return { report: buildQuarterlyReport(raw, context.inputs), generated: buildQuarterlyReport(raw, {}), context, navMissing };
}
