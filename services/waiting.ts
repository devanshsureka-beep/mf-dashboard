/**
 * Calls waiting for clients: advised, not (fully) done yet. Rows come from
 * v_pending_executions, plus what the CAS says about each call. Used by Today
 * and Calls & tranches → Waiting for clients, so both read the same way.
 */
import type { Tx } from "@/lib/db/tx";
import type { AdviceItemView } from "@/types/domain";

export interface WaitingCall {
  advice_item_id: string; client_id: string; client_code: string; client_name: string; advisor_id: string; advisor_name: string | null;
  batch_code: string; security_id: string; scheme_name: string; action: AdviceItemView["action"]; quantity_basis: "AMOUNT" | "UNITS";
  advised_amount: number; advised_units: number | null; executed_amount: number; executed_units: number; pending_amount: number;
  pending_units: number | null; status: string; communicated_at: Date; communication_channel: string; age_days: number;
  phone: string | null;
  /** The latest confirmed CAS, when it is dated on or after the call (and still does not show it done). */
  cas_after: string | null;
  done_on: string | null;
  /** The CAS seems to show this trade, but not clearly enough: one click in the CAS inbox. */
  to_confirm: boolean;
}

export interface WaitingFilters {
  clientId?: string | null;
  advisorId?: string | null;
  status?: "ISSUED" | "PARTIALLY_EXECUTED" | null;
  side?: "BUY" | "SELL" | null;
  stale?: boolean;
  limit?: number | null;
}

export async function listWaiting(tx: Tx, f: WaitingFilters = {}): Promise<WaitingCall[]> {
  return tx<WaitingCall[]>`
    select p.*, c.phone,
           case when l.snapshot_date >= (p.communicated_at at time zone 'Asia/Kolkata')::date then l.snapshot_date::text end as cas_after,
           (select max(e.execution_date)::text from public.executions e where e.advice_item_id = p.advice_item_id and e.status in ('EXECUTED', 'PARTIAL')) as done_on,
           exists (select 1 from public.reconciliation_matches m join public.reconciliation_runs r on r.id = m.run_id
                   where m.advice_item_id = p.advice_item_id and m.status = 'SUGGESTED' and r.status <> 'CANCELLED') as to_confirm
    from public.v_pending_executions p join public.clients c on c.id = p.client_id and c.deleted_at is null
    left join public.v_latest_snapshot l on l.client_id = p.client_id
    where (${f.clientId ?? null}::uuid is null or p.client_id = ${f.clientId ?? null})
      -- "An advisor's" calls are those of the clients they are primary advisor of (same rule as every other figure).
      and (${f.advisorId ?? null}::uuid is null or exists (
            select 1 from public.client_advisor_assignments a
            where a.client_id = p.client_id and a.is_active and a.assignment_role = 'PRIMARY' and a.advisor_id = ${f.advisorId ?? null}))
      and (${f.status ?? null}::text is null or p.status = ${f.status ?? null})
      and (${f.side ?? null}::text is null or (${f.side ?? null} = 'BUY' and p.action = 'BUY') or (${f.side ?? null} = 'SELL' and p.action <> 'BUY'))
      and (${f.stale ? true : null}::boolean is null or p.age_days > 3)
    order by p.age_days desc, p.communicated_at
    limit ${f.limit ?? null}`;
}
