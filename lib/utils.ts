import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A value from the URL that must be an id: the id, or null (never sent to SQL as is). */
export function uuidOrNull(v: unknown): string | null {
  return typeof v === "string" && UUID_RE.test(v) ? v : null;
}
/** A YYYY-MM-DD date from the URL, or null. */
export function isoDateOrNull(v: unknown): string | null {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime()) ? v : null;
}
