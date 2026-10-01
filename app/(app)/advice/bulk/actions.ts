"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { runAction } from "@/lib/actions";
import { AppError } from "@/lib/errors";
import { fromISTDateTimeLocal } from "@/lib/format";
import { actionTx, ADVISORY_ROLES } from "@/lib/server";
import { issueBulkCall, peekFundRef, planBulkCall, type BulkLine } from "@/services/bulk-advice";
import { CHANNELS } from "@/types/domain";

const specSchema = z.object({
  clientIds: z.array(z.uuid()).min(1, "Select at least one client").max(300),
  fundRef: z.string().regex(/^sec:[0-9a-f-]{36}$|^isin:[A-Z]{2}[A-Z0-9]{9}[0-9]$/i, "Choose the fund"),
  action: z.enum(["BUY", "SELL"]),
  mode: z.enum(["FIXED", "PCT_MONEY_LEFT", "PCT_PORTFOLIO", "PCT_HOLDING"]),
  value: z.coerce.number().positive("Enter the amount or percentage"),
});

/** What each client would be told (nothing is saved). */
export async function previewBulkAction(raw: unknown): Promise<{ lines: BulkLine[]; error?: string }> {
  const spec = specSchema.safeParse(raw);
  if (!spec.success) return { lines: [], error: spec.error.issues[0].message };
  try {
    const lines = await actionTx(async (tx) => planBulkCall(tx, spec.data, await peekFundRef(tx, spec.data.fundRef)), { roles: ADVISORY_ROLES });
    return { lines };
  } catch (e) {
    return { lines: [], error: e instanceof AppError ? e.message : "Could not prepare the preview." };
  }
}

export type BulkResult = { ok: true; message: string; issued: { name: string; amount: number; batch: string; onPlan: boolean }[]; skipped: { name: string; reason: string }[] } | { ok: false; error: string };

export async function issueBulkAction(_p: BulkResult | null, fd: FormData): Promise<BulkResult> {
  let out: Extract<BulkResult, { ok: true }> | null = null;
  const res = await runAction("issueBulk", async () => {
    const spec = specSchema.safeParse(JSON.parse(String(fd.get("spec") ?? "{}")));
    if (!spec.success) throw new AppError(spec.error.issues[0].message);
    const channel = String(fd.get("channel") ?? "");
    if (!CHANNELS.includes(channel as (typeof CHANNELS)[number])) throw new AppError("Invalid channel.");
    const when = fromISTDateTimeLocal(String(fd.get("communicated_at") ?? ""));
    if (Number.isNaN(when.getTime())) throw new AppError("Invalid communication time.");
    const notes = String(fd.get("notes") ?? "").trim() || null;
    const r = await actionTx((tx, actor) => issueBulkCall(tx, actor, {
      ...spec.data, communicatedAt: when, channel: channel as (typeof CHANNELS)[number], notes,
    }), { roles: ADVISORY_ROLES });
    out = {
      ok: true,
      message: `${r.issued.length} call(s) recorded${r.skipped.length ? `, ${r.skipped.length} client(s) skipped` : ""}.`,
      issued: r.issued.map((l) => ({ name: `${l.full_name} · ${l.client_code}`, amount: l.amount ?? 0, batch: l.batch_code, onPlan: Boolean(l.plan_item_id) })),
      skipped: r.skipped.map((l) => ({ name: `${l.full_name} · ${l.client_code}`, reason: l.skip ?? "" })),
    };
  });
  if (!res.ok) return res;
  revalidatePath("/advice");
  revalidatePath("/");
  return out!;
}
