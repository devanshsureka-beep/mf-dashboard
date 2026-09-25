/**
 * PDF → text lines (server only, pure Node; no external service).
 *
 * Uses Mozilla pdf.js. Text items on the same visual row are joined with
 * " | " so table columns stay separable; items that touch (e.g. ligatures
 * split as "con" "fi" "dential") are glued back together.
 *
 * Passwords are used only in memory for this call and never stored or logged.
 */

export class PdfPasswordError extends Error {
  constructor(public readonly reason: "NEED_PASSWORD" | "INCORRECT_PASSWORD") {
    super(reason === "NEED_PASSWORD" ? "The PDF is password protected." : "Incorrect PDF password.");
    this.name = "PdfPasswordError";
  }
}

interface TextItemLike {
  str: string;
  transform: number[];
  width: number;
}

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjsPromise: Promise<PdfJs> | null = null;
function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsPromise;
}

async function openDocument(bytes: Uint8Array, password?: string | null) {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({
    // pdf.js may transfer/detach the buffer: always pass a copy.
    data: new Uint8Array(bytes),
    password: password ?? undefined,
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  });
  try {
    const doc = await task.promise;
    return { doc, close: () => task.destroy() };
  } catch (e) {
    await task.destroy().catch(() => {});
    const err = e as { name?: string; code?: number };
    if (err?.name === "PasswordException") {
      throw new PdfPasswordError(err.code === 2 ? "INCORRECT_PASSWORD" : "NEED_PASSWORD");
    }
    throw e;
  }
}

/** Is the PDF encrypted (needs a user password)? */
export async function pdfNeedsPassword(bytes: Uint8Array): Promise<boolean> {
  try {
    const { close } = await openDocument(bytes, null);
    await close();
    return false;
  } catch (e) {
    if (e instanceof PdfPasswordError) return true;
    throw e;
  }
}

/**
 * Try passwords in order; returns the first that opens the PDF (null = no
 * password needed) or throws PdfPasswordError when none works.
 */
export async function findWorkingPassword(bytes: Uint8Array, candidates: (string | null)[]): Promise<string | null> {
  for (const pw of [null, ...candidates.filter((c): c is string => Boolean(c))]) {
    try {
      const { close } = await openDocument(bytes, pw);
      await close();
      return pw;
    } catch (e) {
      if (!(e instanceof PdfPasswordError)) throw e;
    }
  }
  throw new PdfPasswordError("INCORRECT_PASSWORD");
}

export async function extractPdfLines(bytes: Uint8Array, password?: string | null): Promise<string[]> {
  const { doc, close } = await openDocument(bytes, password);
  try {
    const lines: string[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      lines.push(...itemsToLines(content.items as TextItemLike[]));
      lines.push(`@@PAGE_BREAK ${p}`);
      page.cleanup();
    }
    return lines;
  } finally {
    await close();
  }
}

/** Group text items into visual rows (top→bottom), columns joined by " | ". */
export function itemsToLines(items: TextItemLike[]): string[] {
  const rows: { y: number; items: { x: number; end: number; s: string }[] }[] = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const x = it.transform[4];
    const y = it.transform[5];
    let row = rows.find((r) => Math.abs(r.y - y) <= 2);
    if (!row) {
      row = { y, items: [] };
      rows.push(row);
    }
    row.items.push({ x, end: x + (it.width || 0), s: it.str });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((r) => {
    const sorted = r.items.sort((a, b) => a.x - b.x);
    let out = "";
    let prevEnd = -Infinity;
    for (const it of sorted) {
      const touching = it.x - prevEnd < 1.2 && out !== "";
      out += touching ? it.s : (out ? " | " : "") + it.s.trim();
      prevEnd = it.end;
    }
    return out.replace(/\s+/g, " ").trim();
  });
}
