/**
 * "Ask for CAS": a WhatsApp link with a ready message, opened by the advisor
 * (nothing is sent by the app). Without a usable phone number, the client page.
 */
export function askCasHref(c: { client_id: string; full_name: string; phone: string | null }): string {
  const digits = (c.phone ?? "").replace(/\D/g, "");
  const number = digits.length === 10 ? `91${digits}` : digits.length === 12 && digits.startsWith("91") ? digits : null;
  if (!number) return `/clients/${c.client_id}?tab=file&open=details#details`;
  const first = c.full_name.trim().split(/\s+/)[0] ?? "";
  const text = `Hi ${first}, please share your latest CAS statement (CAMS / KFintech) so we can update your portfolio. Thank you.`;
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
}
