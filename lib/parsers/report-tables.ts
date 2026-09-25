/**
 * Rebuild tables from positioned PDF text (pure, layout-independent).
 *
 * A table is found by its header row (first cell "Fund…"). The header cells
 * give the columns. Numbers are right-aligned in their column, text is
 * left-aligned. A row "anchors" where its amount column holds a number; text
 * in the fund column that sits just above / below an anchor (a wrapped fund
 * name) belongs to the nearest anchor. The row starting with "Total" closes
 * the table and carries the printed totals.
 */
import type { PdfItem, PdfPage } from "@/lib/pdf/text";

export interface TableColumn {
  label: string;
  x: number;
  end: number;
}
export interface TableRow {
  /** Fund-column text, wrapped parts joined top to bottom. */
  fund: string;
  /** Cell text per column label (all parts in that column joined). */
  cells: Record<string, string>;
  y: number;
}
export interface ReportTable {
  page: number;
  /** Heading text printed above the table (section title), for classification. */
  title: string;
  columns: TableColumn[];
  rows: TableRow[];
  /** The "Total" row, if printed. */
  total: Record<string, string> | null;
}

const ROW_TOLERANCE = 2.5;
const NUMERIC = /^(?:[-−–]?\s?(?:Rs\.?\s?|₹\s?)?[\d,]+(?:\.\d+)?\*?|[—–-]|n\/a)$/i;
export const isNumericCell = (s: string) => NUMERIC.test(s.trim());

interface Line {
  y: number;
  items: PdfItem[];
}

function toLines(items: PdfItem[]): Line[] {
  const lines: Line[] = [];
  for (const it of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const line = lines.find((l) => Math.abs(l.y - it.y) <= ROW_TOLERANCE);
    if (line) line.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  }
  for (const l of lines) l.items.sort((a, b) => a.x - b.x);
  return lines.sort((a, b) => b.y - a.y);
}

const text = (items: PdfItem[]) => items.map((i) => i.s.trim()).join(" ").replace(/\s+/g, " ").trim();
const isFooter = (l: Line) => /Portfolio Report\s*[—-].*Page \d+|SEBI RIA/i.test(text(l.items));

function columnOf(it: PdfItem, cols: TableColumn[]): number {
  if (isNumericCell(it.s)) {
    // Right-aligned numbers: the column whose header ends near the number's end.
    let best = -1;
    let dist = Infinity;
    cols.forEach((c, i) => {
      const d = it.end >= c.x - 30 && it.end <= c.end + 8 ? Math.abs(c.end - it.end) : Infinity;
      if (d < dist) {
        dist = d;
        best = i;
      }
    });
    if (best >= 0) return best;
  }
  // Left-aligned text: the last column starting at or before the text.
  let idx = 0;
  cols.forEach((c, i) => {
    if (c.x <= it.x + 4) idx = i;
  });
  return idx;
}

export function findTables(pages: PdfPage[], keyColumn: (cols: TableColumn[]) => number[]): ReportTable[] {
  const tables: ReportTable[] = [];
  for (const p of pages) {
    const lines = toLines(p.items);
    for (let h = 0; h < lines.length; h++) {
      const head = lines[h];
      if (head.items.length < 2 || !/^fund\b/i.test(head.items[0].s.trim())) continue;
      const columns: TableColumn[] = head.items.map((i) => ({ label: i.s.trim(), x: i.x, end: i.end }));
      const fundCol = 0;
      const keys = keyColumn(columns);
      const title = lines.slice(Math.max(0, h - 3), h).map((l) => text(l.items)).join(" · ");

      // Collect the lines of this table.
      const body: Line[] = [];
      let total: Record<string, string> | null = null;
      for (let i = h + 1; i < lines.length; i++) {
        const l = lines[i];
        if (isFooter(l)) break;
        if (/^fund\b/i.test(l.items[0].s.trim()) && l.items.length >= 2) break; // next table
        if (l.items[0].x < columns[0].x - 6) break; // prose outside the table
        if (/^total\b/i.test(l.items[0].s.trim())) {
          total = {};
          for (const it of l.items.slice(1)) {
            const c = columns[columnOf(it, columns)];
            total[c.label] = [total[c.label], it.s.trim()].filter(Boolean).join(" ");
          }
          break;
        }
        body.push(l);
      }

      // Split each line into columns; anchors are lines with a number in a key column.
      type Split = { y: number; parts: Record<number, PdfItem[]> };
      const split: Split[] = body.map((l) => {
        const parts: Record<number, PdfItem[]> = {};
        for (const it of l.items) (parts[columnOf(it, columns)] ??= []).push(it);
        return { y: l.y, parts };
      });
      const anchors = split.filter((s) => keys.some((k) => (s.parts[k] ?? []).some((it) => isNumericCell(it.s))));
      if (anchors.length === 0) continue;

      const rowsByAnchor = new Map<Split, { y: number; col: number; items: PdfItem[] }[]>(anchors.map((a) => [a, []]));
      for (const s of split) {
        for (const [colStr, items] of Object.entries(s.parts)) {
          const col = Number(colStr);
          // Nearest anchor by vertical distance (wrapped text sits just above / below its row).
          let best = anchors[0];
          for (const a of anchors) if (Math.abs(a.y - s.y) < Math.abs(best.y - s.y)) best = a;
          if (Math.abs(best.y - s.y) > 16) continue;
          rowsByAnchor.get(best)!.push({ y: s.y, col, items });
        }
      }

      const rows: TableRow[] = anchors.map((a) => {
        const pieces = rowsByAnchor.get(a)!.sort((x, y) => y.y - x.y);
        const cells: Record<string, string> = {};
        for (const pc of pieces) {
          const label = columns[pc.col].label;
          cells[label] = [cells[label], text(pc.items)].filter(Boolean).join(" ");
        }
        return { fund: cells[columns[fundCol].label] ?? "", cells, y: a.y };
      });
      tables.push({ page: p.page, title, columns, rows, total });
    }
  }
  return tables;
}
