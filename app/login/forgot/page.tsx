import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { AuthShell } from "@/components/app/auth-shell";
import { Field, Input } from "@/components/ui/form";
import { authMode } from "@/lib/auth/mode";
import { requestResetAction } from "../password-actions";

export const metadata = { title: "Reset password" };

export default function ForgotPage() {
  if (authMode() !== "app") {
    return <AuthShell title="Reset password"><p className="text-sm">Ask an admin to set a temporary password for you (Team &amp; access).</p></AuthShell>;
  }
  return (
    <AuthShell title="Reset password" subtitle="We email a link to choose a new password. It works once and expires in 45 minutes.">
      <ActionForm action={requestResetAction} className="space-y-4">
        <Field label="Work email"><Input name="email" type="email" autoComplete="username" required /></Field>
        <SubmitButton className="w-full">Send the link</SubmitButton>
      </ActionForm>
    </AuthShell>
  );
}
