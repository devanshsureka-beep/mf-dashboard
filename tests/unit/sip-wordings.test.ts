import { SIP_WORDINGS, NOT_SIP_WORDINGS, SIP_STOP_WORDINGS, NOT_SIP_STOP_WORDINGS } from "../fixtures/txn-wordings";
import { describe, expect, it } from "vitest";
import { classifyTransaction, effectiveTxnType } from "@/lib/parsers/cas";
import { sipPointAsOf, type SipTxn } from "@/lib/domain/sip-status";

describe("SIP instalments, however the RTA words them", () => {
  const sip = [
    "Systematic Purchase - Instalment 3/12",
    "Net Systematic Purchase Instalment No - 11/890 - via Distributor",
    "Sys. Investment (1/120)",
    "Purchase Systematic-BSE - Instalment No - 2/99",
    "Purchase - Systematic U/s 80C of IT Act 1961 - Instalment 4/36",
    "PURCHASE ONGOING SYSTEMATIC-BSE -",
    "Purchase Instalment No - 3/12",
    "SIP Purchase-NSE - Instalment No - 5/60",
    "Systematic Investment (12)",
  ];
  it.each(sip)("%s is a SIP instalment", (d) => {
    expect(classifyTransaction(d, 10).type).toBe("SIP");
    // Rows an older reader stored as a plain purchase are read as SIP too.
    expect(effectiveTxnType("PURCHASE", d, 10)).toBe("SIP");
  });

  it("lump sums, withdrawals, switches and reversals are not", () => {
    expect(classifyTransaction("Purchase-NSE", 10).type).toBe("PURCHASE");
    expect(classifyTransaction("Systematic Withdrawal", -10).type).toBe("REDEMPTION");
    expect(classifyTransaction("Systematic Transfer Plan In (From LF)", 10).type).toBe("SWITCH_IN");
    expect(classifyTransaction("SIP Purchase (Reversal) - Instalment No 3", -10).type).toBe("OTHER");
    expect(effectiveTxnType("PURCHASE", "Purchase-NSE", 10)).toBe("PURCHASE");
    expect(effectiveTxnType("REDEMPTION", "Systematic Withdrawal", -10)).toBe("REDEMPTION");
  });

  it("an instalment reversed or rejected is not the SIP stopping", () => {
    expect(classifyTransaction("SIP Purchase (Reversal) - Instalment No 3 - Cancelled", -10).sipCancelled).toBe(false);
    expect(classifyTransaction("Systematic Investment Rejection (3/12)", null).sipCancelled).toBe(false);
  });

  it.each(["*** SIPCancelled ***", "***SIPTerminated***", "*** Systematic Cancellation ***", "*** Cancelled wef 01-OCT-2026 SIP ceased as per investor", "SIP - Cancelled", "SIP Registration Cancelled", "SIP Mandate Ceased"])(
    "%s stops the SIP", (d) => {
      expect(classifyTransaction(d, null).sipCancelled).toBe(true);
      const txns: SipTxn[] = [
        { date: "2026-08-05", type: "PURCHASE", isin: "INF000000001", scheme_name: "Sample Fund", folio_number: "1", amount: 4999.75, description: "Sys. Investment (1/120)" },
        { date: "2026-09-05", type: "PURCHASE", isin: "INF000000001", scheme_name: "Sample Fund", folio_number: "1", amount: 4999.75, description: "Sys. Investment (2/120)" },
        { date: "2026-09-20", type: "OTHER", isin: "INF000000001", scheme_name: "Sample Fund", folio_number: "1", amount: null, description: d },
      ];
      expect(sipPointAsOf(txns, "2026-09-30").state).toBe("STOPPED");
      expect(sipPointAsOf(txns, "2026-09-10")).toMatchObject({ state: "ACTIVE", amount: 5000 });
    });
});

describe("Every RTA wording (CAMS, KFintech, exchanges)", () => {
  it.each(SIP_WORDINGS)("%s is a SIP instalment", (d) => {
    expect(classifyTransaction(d, 10).type).toBe("SIP");
    expect(effectiveTxnType("PURCHASE", d, 10)).toBe("SIP");
  });
  it.each(NOT_SIP_WORDINGS)("%s is %s", (d, units, type) => {
    expect(classifyTransaction(d, units).type).toBe(type);
  });
  it("an STP out an older reader stored as a switch in counts as a switch out", () => {
    expect(effectiveTxnType("SWITCH_IN", "Systematic Transfer Plan Out (To LC (GP) F-No:2)(To", -10)).toBe("SWITCH_OUT");
    expect(effectiveTxnType("SWITCH_IN", "Systematic Transfer Plan In (From LF)", 10)).toBe("SWITCH_IN");
  });
  it.each(SIP_STOP_WORDINGS)("%s stops the SIP", (d) => expect(classifyTransaction(d, 0).sipCancelled).toBe(true));
  it.each(NOT_SIP_STOP_WORDINGS)("%s does not stop the SIP", (d) => expect(classifyTransaction(d, 0).sipCancelled).toBe(false));
});
