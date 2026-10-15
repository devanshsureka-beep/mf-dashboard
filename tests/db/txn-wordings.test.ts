import { afterAll, describe, expect, it } from "vitest";
import { effectiveTxnType } from "@/lib/parsers/cas";
import { NOT_SIP_WORDINGS, SIP_WORDINGS } from "../fixtures/txn-wordings";
import { sql, TEST_DB } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;
afterAll(async () => {
  await sql?.end();
});

describeDb("txn_effective_type() in the database = effectiveTxnType() in the app", () => {
  it("gives the same type for every wording stored as a purchase or a switch in", async () => {
    const cases: [string, string, number][] = [
      ...SIP_WORDINGS.map((d): [string, string, number] => ["PURCHASE", d, 10]),
      ...NOT_SIP_WORDINGS.flatMap(([d, u]): [string, string, number][] => [["PURCHASE", d, u], ["SWITCH_IN", d, u]]),
    ];
    for (const [type, d, u] of cases) {
      const [row] = await sql!<{ t: string }[]>`select public.txn_effective_type(${type}, ${d}, ${u}) as t`;
      expect(`${type} ${d} → ${row.t}`).toBe(`${type} ${d} → ${effectiveTxnType(type, d, u)}`);
    }
  });
});
