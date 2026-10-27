import Link from "next/link";
import { BrandMark } from "@/components/app/brand-mark";

/** The narrow centred card used by the sign-in side pages (forgot, reset, change password). */
export function AuthShell({ title, subtitle, children, back = true }: { title: string; subtitle?: string; children: React.ReactNode; back?: boolean }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8"><BrandMark tone="light" size="lg" /></div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
        <div className="mt-6 rounded-xl border border-border bg-white p-6 shadow-sm">{children}</div>
        {back ? <p className="mt-4 text-xs text-muted"><Link href="/login" className="text-brand hover:underline">Back to sign in</Link></p> : null}
      </div>
    </main>
  );
}
