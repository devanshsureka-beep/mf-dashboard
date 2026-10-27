import { NextResponse, type NextRequest } from "next/server";
import { getApiActor } from "@/lib/auth/session";
import { withUserTx } from "@/lib/db/tx";
import { logServerError } from "@/lib/errors";
import { periodOf, periodRange, PROOF_LABEL } from "@/lib/domain/overview";
import { todayIST } from "@/lib/format";
import { UUID_RE } from "@/lib/utils";
import { toCsv } from "@/lib/zip";
import { getBookHoldings } from "@/services/book";
import { getOverview } from "@/services/overview";

/** Overview as CSV: the client book, the trades of the period, or (Book view) every holding. */
export async function GET(req: NextRequest) {
  const actor = await getApiActor();
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sp = req.nextUrl.searchParams;
  const view = sp.get("view") === "book" ? "book" : "execution";
  const what = sp.get("what") === "trades" ? "trades" : "clients";
  const period = periodOf(sp.get("period")).key;
  const advisor = sp.get("advisor") ?? "";
  // An advisor exports their own clients only; RLS limits the rows in any case.
  const advisorId = actor.role === "ADVISOR" ? actor.id : UUID_RE.test(advisor) ? advisor : null;
  try {
    const today = todayIST();
    const { name, csv } = await withUserTx(actor, async (tx) => {
      if (view === "book") {
        const rows = await getBookHoldings(tx, advisorId);
        return {
          name: `book holdings ${today}.csv`,
          csv: toCsv(["client", "advisor", "fund", "category", "amc", "plan_type", "value"],
            rows.map((h) => ({ client: h.client_name, advisor: h.advisor_name, fund: h.scheme_name, category: h.category, amc: h.amc, plan_type: h.plan_type, value: Math.round(h.value * 100) / 100 }))),
        };
      }
      const o = await getOverview(tx, { advisorId, ...periodRange(period, today) });
      if (what === "trades") {
        return {
          name: `trades ${period} ${today}.csv`,
          csv: toCsv(["date", "client", "side", "fund", "amount", "proof", "call"],
            o.txns.map((t) => ({ date: t.date, client: t.client, side: t.side, fund: t.fund, amount: t.amount, proof: PROOF_LABEL[t.proof], call: t.call }))),
        };
      }
      return {
        name: `client book ${today}.csv`,
        csv: toCsv(["client", "code", "advisor", "status", "sold", "sell_pending", "bought", "buy_pending", "idle_in_bank", "sip_gap_per_month", "next_action"],
          o.book.map((r) => ({ client: r.name, code: r.code, advisor: r.advisor, status: r.status.label, sold: r.sold, sell_pending: r.sell_pending, bought: r.bought,
            buy_pending: r.buy_pending, idle_in_bank: r.idle, sip_gap_per_month: r.sip_gap, next_action: r.next }))),
      };
    });
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    logServerError("overview-export", e);
    return NextResponse.json({ error: "Export failed" }, { status: 500 });
  }
}
