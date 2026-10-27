import "server-only";
import type { Tx } from "@/lib/db/tx";
import { appBaseUrl, sendEmail } from "@/lib/email";
import { newToken, tokenHash } from "@/lib/auth/tokens";
import { insertLinkToken, LINK_MINUTES } from "@/services/auth-users";

/**
 * A one-time link (password reset or invite): the token is stored hashed in the
 * transaction, then emailed. Plain text, no client data. Returns whether the
 * email went out; the caller decides what to tell the user.
 */
export async function createLink(tx: Tx, userId: string, purpose: "RESET" | "INVITE"): Promise<string> {
  const token = newToken();
  await insertLinkToken(tx, userId, tokenHash(token), purpose);
  return `${appBaseUrl()}/login/reset?token=${token}`;
}

export function sendLinkEmail(to: string, purpose: "RESET" | "INVITE", link: string, name?: string): Promise<boolean> {
  const hello = name ? `Hello ${name},` : "Hello,";
  const text = purpose === "INVITE"
    ? `${hello}\n\nYou have been added to the Univest advisory desk. Set your password here:\n\n${link}\n\nThe link works once and expires in ${LINK_MINUTES} minutes. If it has expired, ask your admin to send a new one.\n`
    : `${hello}\n\nSomeone asked to reset the password of your Univest advisory desk account. Choose a new password here:\n\n${link}\n\nThe link works once and expires in ${LINK_MINUTES} minutes. If you did not ask for this, ignore this email; your password stays the same.\n`;
  return sendEmail(to, purpose === "INVITE" ? "Set your password for the Univest advisory desk" : "Reset your Univest advisory desk password", text);
}
