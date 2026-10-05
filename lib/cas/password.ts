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
  /** Also try parts of the file name itself as the password (bulk onboarding). */
  fileNameParts?: boolean;
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
  if (opts.fileNameParts && opts.fileName) for (const p of fileNamePasswords(opts.fileName)) add(p);
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

const NOISE = /^(cas|pdf|copy|of|final|statement|consolidated|account|detailed|summary|kfin|kfintech|cams|mf|new|latest|password|pwd|pass|pw)$/i;

/**
 * Passwords hidden in a file name with no fixed format, e.g.
 * "Rahul CAS pwd ABCDE1234F.pdf", "CAS_rahul@123.pdf", "ABCDE1234F01011990 cas.pdf".
 * Tried in order: text after a "password/pwd/pass" marker, each part of the
 * name (as written, upper and lower case), neighbouring parts joined, and
 * the whole name. Pure; candidates live only in memory.
 */
export function fileNamePasswords(fileName: string): string[] {
  const base = fileName.replace(/\.pdf$/i, "").replace(/\s*\(\d+\)$/, "").trim();
  const out: string[] = [];
  const add = (p: string | undefined) => {
    const v = (p ?? "").trim();
    if (v.length >= 4 && v.length <= 40 && !out.includes(v)) out.push(v);
  };
  for (const m of base.matchAll(/(?:password|passwd|pwd|pass|pw)\s*[:=\-_ ]\s*([^\s_,;]+)/gi)) add(m[1]);
  const parts = base.split(/[\s_,;()[\]{}]+|(?<=\w)-(?=\w{4,})/).filter(Boolean);
  const useful = parts.filter((x) => !NOISE.test(x));
  for (const x of useful) for (const v of [x, x.toUpperCase(), x.toLowerCase()]) add(v);
  for (let i = 0; i + 1 < useful.length; i++) add(useful[i] + useful[i + 1]);
  if (useful.length) add(base);
  return out.slice(0, 60);
}

/** CAS file names often hold the CAS password, so a CAS document is stored under this neutral name. */
export const CAS_STORED_NAME = "CAS statement.pdf";
