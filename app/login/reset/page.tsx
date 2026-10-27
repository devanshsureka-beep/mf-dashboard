import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { AuthShell } from "@/components/app/auth-shell";
import { Field, Input } from "@/components/ui/form";
import { withSystemTx } from "@/lib/db/tx";
import { authMode } from "@/lib/auth/mode";
import { PASSWORD_MIN } from "@/lib/auth/password";
import { tokenHash } from "@/lib/auth/tokens";
import { peekLinkToken } from "@/services/auth-users";
import { resetPasswordAction } from "../password-actions";

export const metadata = { title: "Set password", referrer: "no-referrer" };

/** Opened from a reset or invite email. The link is only looked at here; it is used up when the password is saved. */
export default async function ResetPage(props: PageProps<"/login/reset">) {
  const sp = await props.searchParams;
  const token = typeof sp.token === "string" ? sp.token : "";
  const link = authMode() === "app" && token && token.length <= 100
    ? await withSystemTx("auth:reset", (tx) => peekLinkToken(tx, tokenHash(token)))
    : null;
  if (!link) {
    return (
      <AuthShell title="Link not valid">
        <p className="text-sm">This link has expired or was already used. <a href="/login/forgot" className="text-brand hover:underline">Ask for a new one</a>, or ask an admin.</p>
      </AuthShell>
    );
  }
  return (
    <AuthShell title={link.purpose === "INVITE" ? "Set your password" : "Choose a new password"} subtitle={link.email}>
      <ActionForm action={resetPasswordAction.bind(null, token)} className="space-y-4">
        <input type="email" name="username" autoComplete="username" value={link.email} readOnly hidden />
        <Field label="New password" hint={`At least ${PASSWORD_MIN} characters.`}><Input name="new_password" type="password" autoComplete="new-password" required minLength={PASSWORD_MIN} /></Field>
        <Field label="Repeat it"><Input name="confirm_password" type="password" autoComplete="new-password" required minLength={PASSWORD_MIN} /></Field>
        <SubmitButton className="w-full">Save password</SubmitButton>
      </ActionForm>
    </AuthShell>
  );
}
