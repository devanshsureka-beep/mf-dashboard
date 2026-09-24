import { Sidebar } from "@/components/app/sidebar";
import { requireActor } from "@/lib/auth/session";
import { signOut } from "@/app/login/actions";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireActor();
  return (
    <div className="min-h-screen">
      <Sidebar name={actor.fullName || actor.email} role={actor.role} signOut={signOut} />
      <main className="pl-60">
        <div className="mx-auto max-w-[1440px] px-6 py-6">{children}</div>
      </main>
    </div>
  );
}
