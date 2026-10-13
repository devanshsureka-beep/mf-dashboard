import type { Tx } from "@/lib/db/tx";
import type { CommandCentreMetrics } from "@/types/domain";

export async function getCommandCentreMetrics(tx: Tx, day?: string | null): Promise<CommandCentreMetrics> {
  const rows = await tx<{ m: CommandCentreMetrics }[]>`select public.command_centre_metrics(${day ?? null}::date) as m`;
  // Assets under advice at the latest daily NAV (CAS value where no NAV yet), and money waiting to be reinvested.
  const live = await tx<{ value: number | null; money_left: number | null }[]>`
    select sum(live_portfolio_value) as value, sum(greatest(money_left, 0)) as money_left
    from public.v_client_summary where status <> 'CLOSED'`;
  return { ...rows[0].m, total_portfolio_value: Number(live[0]?.value ?? rows[0].m.total_portfolio_value), money_left_total: Number(live[0]?.money_left ?? 0) };
}
