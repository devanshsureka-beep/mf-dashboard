import Link from "next/link";
import { PageHeader } from "@/components/app/page-header";
import { todayIST } from "@/lib/format";
import { pageData } from "@/lib/server";
import { getClientSummary } from "@/services/clients";
import { getApprovable } from "@/services/waiting-approve";
import { ApproveWaiting } from "./approve-waiting";
import { approveWaitingAction, undoApprovalAction } from "./actions";

export const metadata = { title: "Approve waiting" };

/** Approve waiting: its own page, opened from the Tranches & SIPs tab. */
export default async function ApproveWaitingPage(props: PageProps<"/clients/[id]/waiting">) {
  const { id } = await props.params;
  const { c, data, actor } = await pageData(async (tx) => ({
    c: await getClientSummary(tx, id),
    data: await getApprovable(tx, id),
  }));
  const back = `/clients/${id}?tab=tranches#ledger`;
  return (
    <>
      <PageHeader
        eyebrow={<><Link href="/clients" className="hover:underline">Clients</Link> › <Link href={`/clients/${id}`} className="hover:underline">{c.full_name}</Link> › Approve waiting</>}
        title="Approve waiting"
        subtitle="What the client has done since the call, before the CAS shows it. Approved lines count in the money right away; the next CAS confirms them."
        actions={<Link href={back} className="rounded-md border border-border bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50">← Back to Tranches &amp; SIPs</Link>}
      />
      <ApproveWaiting
        clientId={id} calls={data.calls} sips={data.sips} approved={data.approved} today={todayIST()}
        canApprove={actor.role !== "OPERATIONS"}
        approve={approveWaitingAction.bind(null, id)} undo={undoApprovalAction.bind(null, id)}
      />
    </>
  );
}
