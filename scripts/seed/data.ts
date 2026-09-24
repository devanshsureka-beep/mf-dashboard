/**
 * Demo reference data. Entirely fictional people. Fund names are illustrative;
 * ISINs use the obviously fake "INFDM…" range and must never be treated as
 * real identifiers.
 */

export interface DemoSecurity {
  key: string;
  name: string;
  amc: string;
  category: string;
  plan: "DIRECT" | "REGULAR";
  asset: "EQUITY" | "DEBT" | "HYBRID" | "COMMODITY";
}

export const SECURITIES: DemoSecurity[] = [
  { key: "AXIS_BLUE_REG", name: "Axis Bluechip Fund - Regular Growth", amc: "Axis", category: "Large Cap", plan: "REGULAR", asset: "EQUITY" },
  { key: "AXIS_BLUE_DIR", name: "Axis Bluechip Fund - Direct Growth", amc: "Axis", category: "Large Cap", plan: "DIRECT", asset: "EQUITY" },
  { key: "ICICI_BLUE_REG", name: "ICICI Prudential Bluechip Fund - Regular Growth", amc: "ICICI Prudential", category: "Large Cap", plan: "REGULAR", asset: "EQUITY" },
  { key: "SBI_FOCUS_REG", name: "SBI Focused Equity Fund - Regular Growth", amc: "SBI", category: "Focused", plan: "REGULAR", asset: "EQUITY" },
  { key: "ABSL_DIGITAL_REG", name: "Aditya Birla SL Digital India Fund - Regular Growth", amc: "Aditya Birla SL", category: "Sectoral / Thematic", plan: "REGULAR", asset: "EQUITY" },
  { key: "NIPPON_SILVER_REG", name: "Nippon India Silver ETF FoF - Regular Growth", amc: "Nippon India", category: "Silver FoF", plan: "REGULAR", asset: "COMMODITY" },
  { key: "NIPPON_GOLD_DIR", name: "Nippon India Gold Savings Fund - Direct Growth", amc: "Nippon India", category: "Gold FoF", plan: "DIRECT", asset: "COMMODITY" },
  { key: "PPFAS_FLEXI_DIR", name: "Parag Parikh Flexi Cap Fund - Direct Growth", amc: "PPFAS", category: "Flexi Cap", plan: "DIRECT", asset: "EQUITY" },
  { key: "PPFAS_FLEXI_REG", name: "Parag Parikh Flexi Cap Fund - Regular Growth", amc: "PPFAS", category: "Flexi Cap", plan: "REGULAR", asset: "EQUITY" },
  { key: "HDFC_FLEXI_DIR", name: "HDFC Flexi Cap Fund - Direct Growth", amc: "HDFC", category: "Flexi Cap", plan: "DIRECT", asset: "EQUITY" },
  { key: "HDFC_FLEXI_REG", name: "HDFC Flexi Cap Fund - Regular Growth", amc: "HDFC", category: "Flexi Cap", plan: "REGULAR", asset: "EQUITY" },
  { key: "KOTAK_EMERGING_DIR", name: "Kotak Emerging Equity Fund - Direct Growth", amc: "Kotak", category: "Mid Cap", plan: "DIRECT", asset: "EQUITY" },
  { key: "MOSL_LARGEMID_DIR", name: "Motilal Oswal Large & Midcap Fund - Direct Growth", amc: "Motilal Oswal", category: "Large & Mid Cap", plan: "DIRECT", asset: "EQUITY" },
  { key: "NIPPON_MULTIASSET_DIR", name: "Nippon India Multi Asset Allocation Fund - Direct Growth", amc: "Nippon India", category: "Multi Asset", plan: "DIRECT", asset: "HYBRID" },
  { key: "BANDHAN_SMALL_DIR", name: "Bandhan Small Cap Fund - Direct Growth", amc: "Bandhan", category: "Small Cap", plan: "DIRECT", asset: "EQUITY" },
  { key: "NIPPON_SMALL_REG", name: "Nippon India Small Cap Fund - Regular Growth", amc: "Nippon India", category: "Small Cap", plan: "REGULAR", asset: "EQUITY" },
  { key: "HDFC_BANKING_DIR", name: "HDFC Banking & Financial Services Fund - Direct Growth", amc: "HDFC", category: "Sectoral: Banking", plan: "DIRECT", asset: "EQUITY" },
  { key: "ICICI_LIQUID_DIR", name: "ICICI Prudential Liquid Fund - Direct Growth", amc: "ICICI Prudential", category: "Liquid", plan: "DIRECT", asset: "DEBT" },
  { key: "MIRAE_ELSS_REG", name: "Mirae Asset ELSS Tax Saver Fund - Regular Growth", amc: "Mirae Asset", category: "ELSS", plan: "REGULAR", asset: "EQUITY" },
  { key: "MIRAE_ELSS_DIR", name: "Mirae Asset ELSS Tax Saver Fund - Direct Growth", amc: "Mirae Asset", category: "ELSS", plan: "DIRECT", asset: "EQUITY" },
  { key: "EDEL_MID_DIR", name: "Edelweiss Mid Cap Fund - Direct Growth", amc: "Edelweiss", category: "Mid Cap", plan: "DIRECT", asset: "EQUITY" },
  { key: "MM_MULTI_REG", name: "Mahindra Manulife Multi Cap Fund - Regular Growth", amc: "Mahindra Manulife", category: "Multi Cap", plan: "REGULAR", asset: "EQUITY" },
  { key: "MM_MULTI_DIR", name: "Mahindra Manulife Multi Cap Fund - Direct Growth", amc: "Mahindra Manulife", category: "Multi Cap", plan: "DIRECT", asset: "EQUITY" },
  { key: "PGIM_FLEXI_REG", name: "PGIM India Flexi Cap Fund - Regular Growth", amc: "PGIM India", category: "Flexi Cap", plan: "REGULAR", asset: "EQUITY" },
  { key: "UTI_NIFTY_DIR", name: "UTI Nifty 50 Index Fund - Direct Growth", amc: "UTI", category: "Index", plan: "DIRECT", asset: "EQUITY" },
  { key: "HDFC_CORPBOND_DIR", name: "HDFC Corporate Bond Fund - Direct Growth", amc: "HDFC", category: "Corporate Bond", plan: "DIRECT", asset: "DEBT" },
];

/** Fake, format-valid ISIN for a demo security (INFDM + 6 digits + 0). */
export const demoIsin = (index: number) => `INFDM${String(index + 1).padStart(6, "0")}0`;

export interface DemoUser {
  key: string;
  email: string;
  fullName: string;
  role: "ADMIN" | "ADVISOR" | "OPERATIONS";
}

export const USERS: DemoUser[] = [
  { key: "admin", email: "admin.demo@example.com", fullName: "Anita Rao", role: "ADMIN" },
  { key: "rohan", email: "rohan.mehta@example.com", fullName: "Rohan Mehta", role: "ADVISOR" },
  { key: "priya", email: "priya.iyer@example.com", fullName: "Priya Iyer", role: "ADVISOR" },
  { key: "karan", email: "karan.shah@example.com", fullName: "Karan Shah", role: "ADVISOR" },
  { key: "neha", email: "neha.verma@example.com", fullName: "Neha Verma", role: "OPERATIONS" },
];
