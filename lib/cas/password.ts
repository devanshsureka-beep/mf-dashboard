/**
 * CAS password candidates (pure).
 *
 * Statements are protected with a house template, e.g. `Prefix{last4}$`, where
 * {last4} is the last 4 digits of the client's registered mobile number. The
 * template is a server-only secret (CAS_PASSWORD_TEMPLATE); passwords are only
 * ever built in memory for the request and never stored or logged.
 */

export const LAST4_PLACEHOLDER = "{last4}";

export function last4(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D+/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

export function fillTemplate(template: string, fourDigits: string): string {
  return template.split(LAST4_PLACEHOLDER).join(fourDigits);
}

/** 4-digit runs in a file name ("Prefix1234.pdf", "CAS_98xxxx1234.pdf"). */
export function digitsFromFileName(fileName: string): string[] {
  const out = new Set<string>();
  for (const m of fileName.matchAll(/\d{4,}/g)) out.add(m[0].slice(-4));
  return [...out];
}

/**
 * Ordered, de-duplicated candidates: explicit passwords first, then the
 * template filled with digits from the file name, then with every known
 * client's mobile number.
 */
export function passwordCandidates(opts: {
  template: string | null | undefined;
  explicit?: (string | null | undefined)[];
  fileName?: string;
  phones?: (string | null | undefined)[];
}): string[] {
  const out: string[] = [];
  const add = (p: string | null | undefined) => {
    if (p && !out.includes(p)) out.push(p);
  };
  for (const p of opts.explicit ?? []) {
    add(p);
    // An explicit 10-digit mobile number is also accepted in place of a password.
    const l4 = /^\+?[\d\s-]{10,15}$/.test(p ?? "") ? last4(p) : null;
    if (l4 && opts.template?.includes(LAST4_PLACEHOLDER)) add(fillTemplate(opts.template, l4));
  }
  const t = opts.template;
  if (t && t.includes(LAST4_PLACEHOLDER)) {
    for (const d of digitsFromFileName(opts.fileName ?? "")) add(fillTemplate(t, d));
    for (const ph of opts.phones ?? []) {
      const d = last4(ph);
      if (d) add(fillTemplate(t, d));
    }
  }
  return out;
}

export function casPasswordTemplate(): string | null {
  const t = process.env.CAS_PASSWORD_TEMPLATE?.trim();
  return t && t.includes(LAST4_PLACEHOLDER) ? t : null;
}
