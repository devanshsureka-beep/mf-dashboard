/** CAS transaction wordings and the type each must be used as (shared by the unit and DB tests). */
export const SIP_WORDINGS = [
  "Sys. Investment (1/120)", "Sys. Investment (12) (3/60)", "SYS. INVESTMENT ISIP (4) (5/120)", "Sys. Investment Existing Folio with SIP (7)",
  "Sys Inv - 3/12", "Syst. Purchase", "Systematic Investment (12)", "Systematic Investment(NAV Dt : 01-Sep-2026) (3)",
  "Systematic Purchase - Instalment 3/12", "Systematic Purchase (Continuous Offer) - Instalment 4", "Systematic Deposit 2/12",
  "Net Systematic Purchase Instalment No - 11/890 - via Distributor", "Purchase Systematic-BSE - Instalment No - 2/99",
  "Purchase - Systematic U/s 80C of IT Act 1961 - Instalment 4/36", "PURCHASE ONGOING SYSTEMATIC-BSE -", "Purchase Instalment No - 3/12",
  "SIP Purchase-NSE - Instalment No - 5/60", "SIPPurchase", "Purchase-SIP-NSE - Instalment No - 7/60", "S.I.P. Purchase", "XSIP Purchase - BSE",
  "ISIP", "Micro SIP 3/36", "NFO SIP Purchase-BSE - Instalment No - 1/60", "Instalment No 4 - 120", "Auto Debit Purchase", "ECS Purchase",
];

export const NOT_SIP_WORDINGS: [string, number, string][] = [
  ["Purchase-NSE", 10, "PURCHASE"], ["Additional Purchase", 10, "PURCHASE"], ["Purchase (Continuous Offer)", 10, "PURCHASE"],
  ["Systematic Withdrawal", -10, "REDEMPTION"], ["Sys. Withdrawal Plan 3/12", -10, "REDEMPTION"],
  ["Systematic Transfer Plan In (From LF (IG) F-No:1)", 10, "SWITCH_IN"], ["Systematic Transfer Plan Out (To MF (GP) F-No:1)(To", -10, "SWITCH_OUT"],
  ["STP Switch In - From Liquid Fund - Growth-NSE - Instalment No 3", 10, "SWITCH_IN"], ["Switch-In - From HDFC Liquid Fund-Growth-NSE - Instalment No 3", 10, "SWITCH_IN"],
  ["Sys. Transfer Out - 4/12", -10, "SWITCH_OUT"], ["SIP Purchase (Reversal) - Instalment No 3", -10, "OTHER"], ["Systematic Investment Rejection (3) (4/60)", -10, "OTHER"],
  ["IDCW Reinvestment", 10, "DIVIDEND_REINVESTMENT"], ["Div. Reinvest", 10, "DIVIDEND_REINVESTMENT"],
  ["*** Invalid Purchase", 0, "OTHER"], ["*** Refund Aadhaar-eKYC investment amount exceeds Rs.50000", 0, "OTHER"],
];

export const SIP_STOP_WORDINGS = ["SIP Cancelled", "SIPCancelled", "SIPTerminated", "SIP Discontinued", "SIP Deactivated", "Sys. Investment Ceased", "Systematic Cancellation", "SIP ceased as per investor request", "XSIP registration revoked"];
export const NOT_SIP_STOP_WORDINGS = ["Sys. Investment (1/120)", "SIP Purchase (Reversal)", "*** Cancelled ***", "Systematic Investment Rejection (3) (4/60)"];
