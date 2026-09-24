import "server-only";
import { logServerError } from "@/lib/errors";
import type { NotificationEvent } from "./contracts";

/**
 * Outbound calls to n8n webhooks. Failures never break the user action; they
 * are logged (without payload, which may contain a CAS password or PII).
 */
async function post(url: string, body: unknown, timeoutMs = 8000): Promise<{ ok: boolean; status: number }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.N8N_WEBHOOK_TOKEN ? { authorization: `Bearer ${process.env.N8N_WEBHOOK_TOKEN}` } : {}),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
      cache: "no-store",
    });
    return { ok: res.ok, status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

export const n8nConfigured = {
  casParse: () => Boolean(process.env.N8N_CAS_PARSE_WEBHOOK_URL),
  advisoryParse: () => Boolean(process.env.N8N_ADVISORY_PARSE_WEBHOOK_URL),
  notifications: () => Boolean(process.env.N8N_NOTIFICATION_WEBHOOK_URL),
};

const callback = (path: string) => `${(process.env.APP_BASE_URL ?? "").replace(/\/$/, "")}${path}`;

/**
 * Ask n8n to extract a CAS. The password (if any) is passed through ONCE in
 * memory and is never stored or logged by this app.
 */
export async function triggerCasParse(args: {
  casDocumentId: string; clientCode: string; clientName: string; fileUrl: string; source: string; password?: string | null;
}): Promise<{ ok: boolean; status: number }> {
  const url = process.env.N8N_CAS_PARSE_WEBHOOK_URL;
  if (!url) return { ok: false, status: 0 };
  try {
    return await post(url, {
      cas_document_id: args.casDocumentId,
      client_code: args.clientCode,
      client_name: args.clientName,
      source: args.source,
      file_url: args.fileUrl,
      file_url_expires_in_seconds: 600,
      password: args.password || null,
      callback_url: callback("/api/integrations/cas-parse-result"),
    });
  } catch (e) {
    logServerError("n8n:cas-parse", e);
    return { ok: false, status: 0 };
  }
}

export async function triggerAdvisoryParse(args: {
  documentId: string; clientCode: string; clientName: string; fileUrl: string;
}): Promise<{ ok: boolean; status: number }> {
  const url = process.env.N8N_ADVISORY_PARSE_WEBHOOK_URL;
  if (!url) return { ok: false, status: 0 };
  try {
    return await post(url, {
      document_id: args.documentId,
      client_code: args.clientCode,
      client_name: args.clientName,
      file_url: args.fileUrl,
      file_url_expires_in_seconds: 600,
      callback_url: callback("/api/integrations/advisory-report-result"),
    });
  } catch (e) {
    logServerError("n8n:advisory-parse", e);
    return { ok: false, status: 0 };
  }
}

/** Fire-and-forget business event (e.g. WhatsApp/email summary in n8n). */
export function notify(event: Omit<NotificationEvent, "occurred_at">): void {
  const url = process.env.N8N_NOTIFICATION_WEBHOOK_URL;
  if (!url) return;
  post(url, { ...event, occurred_at: new Date().toISOString() }, 5000).catch((e) => logServerError("n8n:notify", e));
}
