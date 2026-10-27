import "server-only";
import nodemailer from "nodemailer";
import { logServerError } from "@/lib/errors";

/**
 * Plain emails for sign-in links (password reset, invite), sent over the
 * mailbox's SMTP. Every setting comes from server-only environment variables:
 *   EMAIL_FROM, SMTP_HOST, SMTP_PORT (465 = SSL, 587 = STARTTLS), SMTP_USER, SMTP_PASSWORD.
 * Changing the sender later (e.g. a noreply address) is only EMAIL_FROM and SMTP_USER.
 * Never logs the message body (it holds a one-time link) or the credentials.
 */
export function emailConfigured(): boolean {
  return Boolean(process.env.EMAIL_FROM && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD);
}

export async function sendEmail(to: string, subject: string, text: string): Promise<boolean> {
  if (!emailConfigured()) {
    logServerError("email", new Error("Email is not configured (EMAIL_FROM / SMTP_*)."));
    return false;
  }
  const port = Number(process.env.SMTP_PORT || 465);
  try {
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      requireTLS: port !== 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 20_000,
    });
    await transport.sendMail({ from: process.env.EMAIL_FROM, to, subject, text });
    return true;
  } catch (e) {
    // The SMTP error only: no recipient body, no link, no password.
    const code = (e as { code?: string; responseCode?: number } | null);
    logServerError("email", new Error(`SMTP send failed (${code?.code ?? ""} ${code?.responseCode ?? ""})`.trim()));
    return false;
  }
}

export function appBaseUrl(): string {
  return (process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
}
