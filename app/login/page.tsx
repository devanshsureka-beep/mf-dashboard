import { redirect } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { BrandMark } from "@/components/app/brand-mark";
import { Field, Input } from "@/components/ui/form";
import { getCurrentActor } from "@/lib/auth/session";
import { BRAND } from "@/lib/brand";
import { signIn } from "./actions";

export const metadata = { title: "Sign in" };

export default async function LoginPage() {
  if (await getCurrentActor()) redirect("/");
  return (
    <main className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <section className="relative hidden overflow-hidden bg-sidebar p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="pointer-events-none absolute -right-32 -top-32 h-96 w-96 rounded-full bg-brand-500/20 blur-3xl" aria-hidden />
        <div className="pointer-events-none absolute -bottom-40 -left-24 h-96 w-96 rounded-full bg-brand-700/30 blur-3xl" aria-hidden />
        <BrandMark size="lg" className="relative" />
        <div className="relative max-w-md">
          <h2 className="text-3xl font-semibold leading-tight tracking-tight">
            The desk for every {BRAND.product} client.
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-sidebar-ink">
            Onboard from the CAS and the advisory report, log each call, and let every new CAS confirm what was executed.
          </p>
          <ul className="mt-8 space-y-2 text-sm text-sidebar-ink">
            <li className="flex gap-2"><span className="text-brand-300">●</span> Plan: what the report recommends</li>
            <li className="flex gap-2"><span className="text-brand-300">●</span> Calls: what we told the client, and when</li>
            <li className="flex gap-2"><span className="text-brand-300">●</span> Execution: what the CAS proves was done</li>
          </ul>
        </div>
        <p className="relative text-xs text-sidebar-muted">Internal use only · {BRAND.company}</p>
      </section>

      <section className="flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            <BrandMark tone="light" size="lg" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
          <p className="mt-1 text-sm text-muted">Use your {BRAND.company} staff account.</p>
          <div className="mt-6 rounded-xl border border-border bg-white p-6 shadow-sm">
            <ActionForm action={signIn} className="space-y-4">
              <Field label="Work email">
                <Input name="email" type="email" autoComplete="username" required />
              </Field>
              <Field label="Password">
                <Input name="password" type="password" autoComplete="current-password" required />
              </Field>
              <SubmitButton className="w-full">Sign in</SubmitButton>
            </ActionForm>
          </div>
          <p className="mt-4 text-xs text-muted">Accounts are created by an admin. There is no public sign-up.</p>
        </div>
      </section>
    </main>
  );
}
