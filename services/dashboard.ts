import type { Tx } from "@/lib/db/tx";
import type { CommandCentreMetrics } from "@/types/domain";

export async function getCommandCentreMetrics(tx: Tx, day?: string | null): Promise<CommandCentreMetrics> {
  const rows = await tx<{ m: CommandCentreMetrics }[]>`select public.command_centre_metrics(${day ?? null}::date) as m`;
  return rows[0].m;
}

export async function listReviewDue(tx: Tx, limit = 10) {
  return tx<{ client_id: string; client_code: string; full_name: string; next_review_date: string; advisor_name: string | null }[]>`
    select client_id, client_code, full_name, next_review_date, advisor_name
    from public.v_client_summary
    where next_review_date is not null and next_review_date <= app.today_ist() + 7 and status <> 'CLOSED'
    order by next_review_date limit ${limit}`;
}

export async function listDocumentsNeedingReview(tx: Tx, limit = 10) {
  return tx<{ kind: string; id: string; client_id: string; client_name: string; label: string; status: string; at: Date }[]>`
    select 'CAS' as kind, cd.id, cd.client_id, c.full_name as client_name,
           coalesce(d.file_name, 'CAS') as label, cd.parse_status as status, cd.uploaded_at as at
    from public.cas_documents cd
    join public.clients c on c.id = cd.client_id
    join public.documents d on d.id = cd.document_id
    where cd.parse_status in ('NEEDS_REVIEW', 'FAILED')
    union all
    select 'SNAPSHOT', s.id, s.client_id, c.full_name, 'Snapshot ' || to_char(s.snapshot_date, 'DD-Mon-YYYY'),
           s.review_status, s.created_at
    from public.portfolio_snapshots s join public.clients c on c.id = s.client_id
    where s.review_status = 'PENDING_REVIEW'
    union all
    select 'PLAN', p.id, p.client_id, c.full_name, p.plan_name, 'DRAFT', p.created_at
    from public.advisory_plans p join public.clients c on c.id = p.client_id
    where p.status = 'DRAFT'
    order by at desc limit ${limit}`;
}
