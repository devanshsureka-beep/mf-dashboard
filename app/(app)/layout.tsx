import { Sidebar } from "@/components/app/sidebar";
import { requireActor } from "@/lib/auth/session";
import { signOut } from "@/app/login/actions";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireActor();
  return (
    <div className="min-h-screen">
      <Sidebar name={actor.fullName || actor.email} role={actor.role} signOut={signOut} />
      <main className="lg:pl-64">
        <div className="mx-auto max-w-[1440px] px-4 py-5 sm:px-6 lg:px-8 lg:py-7">{children}</div>
      </main>
    </div>
  );
}
