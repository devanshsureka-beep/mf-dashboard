import type { Tx } from "@/lib/db/tx";

/** Counts shown next to the menu items (RLS: only the user's clients). */
export async function getNavCounts(tx: Tx): Promise<{ awaitingExecution: number; casInbox: number }> {
  const r = (await tx<{ calls: number; snaps: number; unadvised: number }[]>`
    select
      (select count(*)::int from public.v_advice_items v where v.is_open) as calls,
      (select count(distinct s.client_id)::int from public.portfolio_snapshots s where s.review_status = 'PENDING_REVIEW') as snaps,
      (select count(distinct m.client_id)::int from public.reconciliation_matches m join public.reconciliation_runs r on r.id = m.run_id
        where r.status <> 'CANCELLED' and m.classification = 'UNADVISED' and m.status in ('UNEXPLAINED', 'SUGGESTED') and m.reviewed_at is null) as unadvised`)[0];
  return { awaitingExecution: r?.calls ?? 0, casInbox: (r?.snaps ?? 0) + (r?.unadvised ?? 0) };
}
