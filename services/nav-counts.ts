import type { Tx } from "@/lib/db/tx";
import { listApprovedMissing } from "./cas-inbox";

/** Sidebar badges: open calls, and clients the CAS inbox "Needs you" tab lists (same rules as getCasInbox). */
export async function getNavCounts(tx: Tx): Promise<{ awaitingExecution: number; casInbox: number }> {
  const r = (await tx<{ calls: number; inbox: string[] }[]>`
    select
      (select count(*)::int from public.v_advice_items v where v.is_open) as calls,
      (select coalesce(array_agg(distinct client_id), '{}') from (
        select s.client_id from public.portfolio_snapshots s where s.review_status = 'PENDING_REVIEW'
        union all
        select m.client_id from public.reconciliation_matches m join public.reconciliation_runs r on r.id = m.run_id
        where r.status <> 'CANCELLED' and m.classification = 'UNADVISED' and m.status in ('UNEXPLAINED', 'SUGGESTED') and m.reviewed_at is null
        union all
        select m.client_id from public.reconciliation_matches m join public.reconciliation_runs r on r.id = m.run_id
        join public.advice_items a on a.id = m.advice_item_id and a.status in ('ISSUED', 'PARTIALLY_EXECUTED', 'EXECUTED')
        where r.status <> 'CANCELLED' and m.classification = 'ADVICE_MATCH' and m.status = 'SUGGESTED'
        union all
        select cd.client_id from public.cas_documents cd
        where cd.parse_status in ('UPLOADED', 'PROCESSING', 'FAILED') and cd.uploaded_at > now() - interval '14 days'
          and not exists (select 1 from public.portfolio_snapshots s where s.cas_document_id = cd.id)
      ) x) as inbox`)[0];
  // Plus approved trades the latest CAS does not show (the inbox lists those clients too).
  const ids = new Set([...(r?.inbox ?? []), ...(await listApprovedMissing(tx)).map((m) => m.client_id)]);
  return { awaitingExecution: r?.calls ?? 0, casInbox: ids.size };
}
