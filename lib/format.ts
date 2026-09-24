/**
 * Indian formatting helpers. Pure functions (safe on server and client).
 *   formatINRCompact(1577657)  -> "₹15.78L"
 *   formatINRCompact(10200000) -> "₹1.02Cr"
 *   formatINR(1577657)         -> "₹15,77,657"
 */

const LAKH = 100_000;
const CRORE = 10_000_000;

const inrFull = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const inrFull2 = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function toNumber(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function formatINR(value: number | string | null | undefined, opts: { decimals?: boolean } = {}): string {
  const n = toNumber(value);
  if (n === null) return "—";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}₹${opts.decimals ? inrFull2.format(abs) : inrFull.format(Math.round(abs))}`;
}

export function formatINRCompact(value: number | string | null | undefined): string {
  const n = toNumber(value);
  if (n === null) return "—";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= CRORE) return `${sign}₹${trimZeros((abs / CRORE).toFixed(2))}Cr`;
  if (abs >= LAKH) return `${sign}₹${trimZeros((abs / LAKH).toFixed(2))}L`;
  if (abs >= 1000) return `${sign}₹${trimZeros((abs / 1000).toFixed(1))}K`;
  return `${sign}₹${inrFull.format(Math.round(abs))}`;
}

function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

export function formatUnits(value: number | string | null | undefined): string {
  const n = toNumber(value);
  if (n === null) return "—";
  return new Intl.NumberFormat("en-IN", { minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(n);
}

export function formatNav(value: number | string | null | undefined): string {
  const n = toNumber(value);
  if (n === null) return "—";
  return new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(n);
}

export function formatPct(value: number | string | null | undefined, digits = 1): string {
  const n = toNumber(value);
  if (n === null) return "—";
  return `${n.toFixed(digits)}%`;
}

const IST = "Asia/Kolkata";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "24-Sep-2026" for a date string (YYYY-MM-DD) or Date. */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00+05:30`) : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const parts = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "numeric", year: "numeric", timeZone: IST }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")}-${MONTHS[Number(get("month")) - 1]}-${get("year")}`;
}

/** "24-Sep-2026 10:42 AM" in IST. */
export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: IST }).format(d);
  return `${formatDate(d)} ${time}`;
}

/** Today's date in IST as YYYY-MM-DD. */
export function todayIST(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: IST, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Value for <input type="datetime-local"> in IST. */
export function toISTDateTimeLocal(d: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: IST, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}`;
}

/** Parse a datetime-local value entered in IST into a Date. */
export function fromISTDateTimeLocal(v: string): Date {
  return new Date(`${v.length === 16 ? `${v}:00` : v}+05:30`);
}

export function humanize(value: string | null | undefined): string {
  if (!value) return "—";
  return value
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
