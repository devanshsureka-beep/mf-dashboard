import { AppError, logServerError, toUserMessage } from "@/lib/errors";

/** Result shape of every server action used with <ActionForm>. */
export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

/** Wrap a server action body: never leak internals, never swallow failures. */
export async function runAction(context: string, fn: () => Promise<string | void>): Promise<ActionResult> {
  try {
    const message = await fn();
    return { ok: true, message: message ?? undefined };
  } catch (e) {
    // redirect()/notFound() throw special errors that must propagate.
    if (e && typeof e === "object" && "digest" in e && String((e as { digest: unknown }).digest).startsWith("NEXT_")) throw e;
    if (!(e instanceof AppError)) logServerError(context, e);
    return { ok: false, error: toUserMessage(e) };
  }
}

/** FormData helpers */
export const str = (fd: FormData, k: string): string => String(fd.get(k) ?? "").trim();
export const optStr = (fd: FormData, k: string): string | null => {
  const v = str(fd, k);
  return v === "" ? null : v;
};
export const num = (fd: FormData, k: string): number | null => {
  const v = str(fd, k).replace(/[,₹\s]/g, "");
  if (v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new AppError(`"${k}" must be a number.`);
  return n;
};
export const reqNum = (fd: FormData, k: string, label = k): number => {
  const n = num(fd, k);
  if (n === null) throw new AppError(`${label} is required.`);
  return n;
};
export const reqStr = (fd: FormData, k: string, label = k): string => {
  const v = str(fd, k);
  if (!v) throw new AppError(`${label} is required.`);
  return v;
};
