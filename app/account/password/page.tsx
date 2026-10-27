import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { AuthShell } from "@/components/app/auth-shell";
import { Field, Input } from "@/components/ui/form";
import { requireActor } from "@/lib/auth/session";
import { PASSWORD_MIN } from "@/lib/auth/password";
import { changePasswordAction } from "@/app/login/password-actions";

export const metadata = { title: "Change password" };

/** Outside the app layout: a user with a temporary password lands here before anything else. */
export default async function ChangePasswordPage() {
  const actor = await requireActor(undefined, { passwordChange: true });
  return (
    <AuthShell
      title={actor.mustChangePassword ? "Choose your own password" : "Change password"}
      subtitle={actor.mustChangePassword ? "An admin set a temporary password for you. Choose your own before you continue." : actor.email}
      back={false}
    >
      <ActionForm action={changePasswordAction} className="space-y-4" resetOnSuccess>
        <input type="email" name="username" autoComplete="username" value={actor.email} readOnly hidden />
        <Field label={actor.mustChangePassword ? "Temporary password" : "Current password"}><Input name="current_password" type="password" autoComplete="current-password" required /></Field>
        <Field label="New password" hint={`At least ${PASSWORD_MIN} characters.`}><Input name="new_password" type="password" autoComplete="new-password" required minLength={PASSWORD_MIN} /></Field>
        <Field label="Repeat it"><Input name="confirm_password" type="password" autoComplete="new-password" required minLength={PASSWORD_MIN} /></Field>
        <SubmitButton className="w-full">Change password</SubmitButton>
      </ActionForm>
      {!actor.mustChangePassword ? <p className="mt-4 text-xs"><Link href="/" className="text-brand hover:underline">Back to the desk</Link></p> : null}
    </AuthShell>
  );
}
