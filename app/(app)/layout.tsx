import { Sidebar } from "@/components/app/sidebar";
import { requireActor } from "@/lib/auth/session";
import { withUserTx } from "@/lib/db/tx";
import { getNavCounts } from "@/services/nav-counts";
import { signOut } from "@/app/login/actions";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireActor();
  // Badges are a convenience: a failure here must never take the page down.
  const counts = await withUserTx(actor, (tx) => getNavCounts(tx)).catch(() => ({ awaitingExecution: 0, casInbox: 0 }));
  return (
    <div className="min-h-screen">
      <Sidebar name={actor.fullName || actor.email} role={actor.role} signOut={signOut} counts={counts} />
      <main className="lg:pl-60 print:pl-0">
        <div className="mx-auto max-w-[1440px] px-4 py-5 sm:px-6 lg:px-8 lg:py-6 print:max-w-none print:p-0">{children}</div>
      </main>
    </div>
  );
}
