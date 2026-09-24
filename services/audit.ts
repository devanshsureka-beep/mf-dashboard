import type { Tx } from "@/lib/db/tx";
import type { AuditLogRow } from "@/types/domain";

export interface AuditFilters {
  clientId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  actorId?: string | null;
  from?: string | null;
  to?: string | null;
  limit?: number;
}

export async function listAuditLogs(tx: Tx, f: AuditFilters = {}): Promise<AuditLogRow[]> {
  return tx<AuditLogRow[]>`
    select a.*, p.full_name as actor_name, c.full_name as client_name
    from public.audit_logs a
    left join public.profiles p on p.id = a.actor_id
    left join public.clients c on c.id = a.client_id
    where (${f.clientId ?? null}::uuid is null or a.client_id = ${f.clientId ?? null})
      and (${f.entityType ?? null}::text is null or a.entity_type = ${f.entityType ?? null})
      and (${f.entityId ?? null}::uuid is null or a.entity_id = ${f.entityId ?? null})
      and (${f.actorId ?? null}::uuid is null or a.actor_id = ${f.actorId ?? null})
      and (${f.from ?? null}::date is null or (a.occurred_at at time zone 'Asia/Kolkata')::date >= ${f.from ?? null}::date)
      and (${f.to ?? null}::date is null or (a.occurred_at at time zone 'Asia/Kolkata')::date <= ${f.to ?? null}::date)
    order by a.occurred_at desc, a.id desc
    limit ${f.limit ?? 200}`;
}
