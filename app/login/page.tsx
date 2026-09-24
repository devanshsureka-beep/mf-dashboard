import { redirect } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { Field, Input } from "@/components/ui/form";
import { getCurrentActor } from "@/lib/auth/session";
import { signIn } from "./actions";

export const metadata = { title: "Sign in" };

export default async function LoginPage() {
  if (await getCurrentActor()) redirect("/");
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-brand text-sm font-bold text-white">MN</div>
          <h1 className="text-lg font-semibold">MN Advisory Dashboard</h1>
          <p className="text-sm text-muted">Staff sign-in</p>
        </div>
        <div className="rounded-lg border border-border bg-white p-6 shadow-sm">
          <ActionForm action={signIn} className="space-y-4">
            <Field label="Email">
              <Input name="email" type="email" autoComplete="username" required />
            </Field>
            <Field label="Password">
              <Input name="password" type="password" autoComplete="current-password" required />
            </Field>
            <SubmitButton className="w-full">Sign in</SubmitButton>
          </ActionForm>
        </div>
        <p className="mt-4 text-center text-xs text-muted">Accounts are created by an administrator. Public sign-up is disabled.</p>
      </div>
    </main>
  );
}
