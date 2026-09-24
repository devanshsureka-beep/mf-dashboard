/**
 * Demo seed: 5 staff users (1 admin, 3 advisors, 1 operations), 10 clients.
 *
 * Every business record is created through the SAME service functions the app
 * uses, as the relevant signed-in user under Row Level Security, so seeding
 * also exercises the business rules (triggers, audit trail, status derivation).
 *
 * Run:  npm run seed          (requires .env.local, see README)
 * Only for development / staging databases.
 */
import { createClient } from "@supabase/supabase-js";
import { createSql } from "@/lib/db/client";
import { withSystemTx, withUserTx, type Actor, type Tx } from "@/lib/db/tx";
import type { CasParsed } from "@/lib/integrations/contracts";
import { createClient as createClientRecord } from "@/services/clients";
import { confirmSnapshot, createSnapshotFromParsed, ingestCasParseResult, registerCasDocument } from "@/services/portfolio";
import { addPlanItem, addSipItem, approvePlan, createDraftPlan, ingestAdvisoryReport, setSipStatus, updatePlanItem } from "@/services/plans";
import { closeAdvice, issueAdvice, reviseAdvice, type IssueAdviceItemInput } from "@/services/advice";
import { recordExecution } from "@/services/executions";
import { runReconciliation } from "@/services/reconciliation";
import { addNote } from "@/services/notes";
import { demoIsin, SECURITIES, USERS } from "./data";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* rely on real environment variables */
}

const required = ["DATABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SEED_DEMO_PASSWORD"];
for (const k of required) {
  if (!process.env[k]) {
    console.error(`Missing ${k}. See .env.example.`);
    process.exit(1);
  }
}
if (process.env.NODE_ENV === "production" && !process.argv.includes("--allow-production")) {
  console.error("Refusing to seed demo data with NODE_ENV=production.");
  process.exit(1);
}

const sql = createSql(process.env.DATABASE_URL!, 3);
const users: Record<string, Actor> = {};
const sec: Record<string, { id: string; name: string; isin: string }> = {};

// ---------------------------------------------------------------------------
// Time helpers (IST)
// ---------------------------------------------------------------------------
const DAY = 86_400_000;
function istDate(daysAgo: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(Date.now() - daysAgo * DAY));
}
/** A timestamp `daysAgo` days back at hh:mm IST (for daysAgo = 0, clamped to "a bit ago"). */
function at(daysAgo: number, hh = 10, mm = 0): Date {
  const d = new Date(`${istDate(daysAgo)}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+05:30`);
  return d.getTime() > Date.now() - 60_000 ? new Date(Date.now() - 20 * 60_000) : d;
}
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

const as = <T>(userKey: string, fn: (tx: Tx) => Promise<T>, reason?: string) =>
  withUserTx(users[userKey], fn, { sql, reason });

// ---------------------------------------------------------------------------
// Snapshot helper
// ---------------------------------------------------------------------------
type Line = [secKey: string, units: number, nav: number, costRatio?: number];
let folioSeq = 7100;
const folioFor = new Map<string, string>();
function folio(clientKey: string, secKey: string) {
  const k = `${clientKey}:${secKey}`;
  if (!folioFor.has(k)) folioFor.set(k, `${folioSeq++}${String(folioSeq % 97).padStart(2, "0")}/01`);
  return folioFor.get(k)!;
}
function parsed(clientKey: string, date: string, lines: Line[], txns: CasParsed["transactions"] = []): CasParsed {
  return {
    cas_document_id: "00000000-0000-0000-0000-000000000000",
    status: "PARSED",
    extraction_method: "DETERMINISTIC_PARSER",
    statement: { source: "CAMS", valuation_date: date, statement_from_date: null, statement_to_date: date },
    holdings: lines.map(([k, units, nav, costRatio]) => {
      const s = SECURITIES.find((x) => x.key === k)!;
      const value = Math.round(units * nav * 100) / 100;
      return {
        scheme_name: sec[k].name, isin: sec[k].isin, amc: s.amc, folio_number: folio(clientKey, k), plan_type: s.plan,
        category: s.category, units, nav, nav_date: date, current_value: value,
        cost_value: Math.round(value * (costRatio ?? 0.9)),
      };
    }),
    transactions: txns,
    totals: null,
    warnings: [],
  };
}

async function baselineSnapshot(advisor: string, clientId: string, clientKey: string, date: string, lines: Line[]) {
  return as(advisor, async (tx) => {
    const id = await createSnapshotFromParsed(tx, {
      clientId, casDocumentId: null, parsed: parsed(clientKey, date, lines), source: "SEED", createdBy: users[advisor].id,
    });
    await confirmSnapshot(tx, id, "Seed baseline");
    return id;
  });
}

// ---------------------------------------------------------------------------
// Plan helper
// ---------------------------------------------------------------------------
interface PlanSpec {
  sells: [secKey: string, amount: number, action?: "SELL" | "SWITCH", units?: number][];
  buys: [secKey: string, amount: number][];
  sips?: [secKey: string, action: "START" | "STOP", amount: number][];
  approvedDaysAgo: number;
  name?: string;
}
async function activePlan(advisor: string, clientId: string, snapshotId: string, spec: PlanSpec) {
  return as(advisor, async (tx) => {
    const planId = await createDraftPlan(tx, users[advisor], {
      clientId, planName: spec.name ?? "Onboarding rebalancing plan", fromSnapshotId: snapshotId,
      planDate: istDate(spec.approvedDaysAgo + 1), notes: "Target end-state after onboarding review.",
    });
    const items = await tx<{ id: string; security_id: string; scheme_name: string; current_amount: number }[]>`
      select id, security_id, scheme_name, current_amount from public.advisory_plan_items where plan_id = ${planId}`;
    let priority = 10;
    for (const [k, amount, action, units] of spec.sells) {
      const it = items.find((i) => i.security_id === sec[k].id)!;
      await updatePlanItem(tx, it.id, {
        security_id: it.security_id, scheme_name: it.scheme_name, action: action ?? "SELL", target_amount: amount,
        target_units: units ?? null, current_amount: it.current_amount, priority: priority,
        reason: amount >= it.current_amount - 1 ? "Full exit: regular plan / weak category rank" : "Partial trim to target weight",
      });
      priority += 10;
    }
    for (const [k, amount] of spec.buys) {
      await addPlanItem(tx, users[advisor], planId, {
        security_id: sec[k].id, scheme_name: sec[k].name, action: "BUY", target_amount: amount, priority, reason: "Target allocation (direct plan)",
      });
      priority += 10;
    }
    for (const [k, action, amount] of spec.sips ?? []) {
      await addSipItem(tx, users[advisor], planId, {
        security_id: sec[k].id, scheme_name: sec[k].name, action,
        old_amount: action === "STOP" ? amount : null, new_amount: action === "START" ? amount : null, debit_day: 7,
      });
    }
    await approvePlan(tx, users[advisor], planId, "Approved after client review meeting", at(spec.approvedDaysAgo, 17, 30));
    return planId;
  });
}

async function planItemId(clientId: string, secKey: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    select pi.id from public.advisory_plan_items pi join public.advisory_plans p on p.id = pi.plan_id
    where p.client_id = ${clientId} and p.status = 'ACTIVE' and pi.security_id = ${sec[secKey].id}`;
  if (!rows[0]) throw new Error(`No plan item for ${secKey}`);
  return rows[0].id;
}

type CallSpec = [secKey: string, action: "BUY" | "SELL" | "SWITCH", amount: number, units?: number, refPrice?: number];
async function call(advisor: string, clientId: string, when: Date, channel: "PHONE" | "WHATSAPP" | "EMAIL" | "IN_PERSON", calls: CallSpec[], notes?: string) {
  const items: IssueAdviceItemInput[] = [];
  for (const [k, action, amount, units, ref] of calls) {
    items.push({
      plan_item_id: await planItemId(clientId, k).catch(() => null),
      security_id: sec[k].id, action, quantity_basis: units ? "UNITS" : "AMOUNT", advised_amount: amount,
      advised_units: units ?? null, reference_price: ref ?? null,
    });
  }
  return as(advisor, (tx) => issueAdvice(tx, users[advisor], { clientId, communicatedAt: when, channel, notes, items }));
}

async function execute(
  userKey: string, adviceItemId: string, daysAgo: number, amount: number,
  verification: "CLIENT_CONFIRMED" | "ADVISOR_CONFIRMED" | "PROOF_VERIFIED", units?: number, notes?: string,
) {
  return as(userKey, (tx) => recordExecution(tx, users[userKey], {
    adviceItemId, executionDate: istDate(daysAgo), executedAmount: amount, executedUnits: units ?? null,
    verificationType: verification, notes: notes ?? null,
  }));
}

// ---------------------------------------------------------------------------
async function ensureUsers() {
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: list, error: listErr } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (listErr) throw listErr;
  for (const u of USERS) {
    let id = list.users.find((x) => x.email === u.email)?.id;
    if (!id) {
      const { data, error } = await admin.auth.admin.createUser({
        email: u.email, password: process.env.SEED_DEMO_PASSWORD!, email_confirm: true,
        app_metadata: { mn_role: u.role, mn_full_name: u.fullName, mn_active: true },
      });
      if (error) throw error;
      id = data.user.id;
    }
    await withSystemTx("seed", (tx) => tx`
      insert into public.profiles (id, email, full_name, role, is_active)
      values (${id!}, ${u.email}, ${u.fullName}, ${u.role}, true)
      on conflict (id) do update set full_name = excluded.full_name, role = excluded.role, is_active = true`, { sql });
    users[u.key] = { id, email: u.email, fullName: u.fullName, role: u.role };
  }
}

async function ensureSecurities() {
  await withSystemTx("seed", async (tx) => {
    for (const [i, s] of SECURITIES.entries()) {
      const isin = demoIsin(i);
      const rows = await tx<{ id: string }[]>`
        insert into public.security_master (isin, scheme_name, amc, category, plan_type, asset_class, option_type)
        values (${isin}, ${s.name}, ${s.amc}, ${s.category}, ${s.plan}, ${s.asset}, 'GROWTH')
        on conflict (isin) do update set scheme_name = excluded.scheme_name
        returning id`;
      sec[s.key] = { id: rows[0].id, name: s.name, isin };
    }
  }, { sql });
}

async function newClient(advisor: string, c: {
  name: string; email: string; phone: string; pan?: string; risk: string; goal: string; status: string; onboardedDaysAgo: number; reviewInDays?: number;
}) {
  const created = await as(advisor, (tx) => createClientRecord(tx, users[advisor], {
    full_name: c.name, email: c.email, phone: c.phone, pan: c.pan ?? null, risk_profile: c.risk, goal: c.goal,
    status: c.status, onboarding_date: istDate(c.onboardedDaysAgo),
    next_review_date: c.reviewInDays === undefined ? null : istDate(-c.reviewInDays),
  }));
  return created.id;
}

// ---------------------------------------------------------------------------
async function main() {
  const existing = await sql<{ n: number }[]>`select count(*)::int as n from public.clients where email like '%@example.com'`;
  if (existing[0].n > 0) {
    console.log("Demo data already present — nothing to do. Reset the database to reseed.");
    return;
  }
  await ensureUsers();
  await ensureSecurities();
  console.log("users + securities ready");

  // ===== C1: the ₹1 crore client =====================================================
  const c1 = await newClient("rohan", {
    name: "Arjun Malhotra", email: "arjun.malhotra@example.com", phone: "+91 98200 11001", pan: "ABCPM1234K",
    risk: "MODERATELY_AGGRESSIVE", goal: "Wealth creation; retirement corpus by 2040", status: "ACTIVE", onboardedDaysAgo: 16, reviewInDays: 5,
  });
  const c1snap = await baselineSnapshot("rohan", c1, "c1", istDate(14), [
    ["AXIS_BLUE_REG", 40000, 62.5, 0.82], ["PGIM_FLEXI_REG", 50000, 36, 0.9], ["ABSL_DIGITAL_REG", 5000, 160, 1.05],
    ["NIPPON_SILVER_REG", 40000, 17.5, 1.12], ["KOTAK_EMERGING_DIR", 16000, 137.5, 0.7], ["NIPPON_GOLD_DIR", 25000, 40, 0.8],
    ["ICICI_LIQUID_DIR", 250, 4000, 0.97],
  ]);
  await activePlan("rohan", c1, c1snap, {
    approvedDaysAgo: 12,
    sells: [["AXIS_BLUE_REG", 1500000], ["PGIM_FLEXI_REG", 1200000], ["ABSL_DIGITAL_REG", 800000], ["NIPPON_SILVER_REG", 700000]],
    buys: [["HDFC_FLEXI_DIR", 1200000], ["MOSL_LARGEMID_DIR", 1000000], ["NIPPON_MULTIASSET_DIR", 1000000], ["BANDHAN_SMALL_DIR", 500000], ["HDFC_BANKING_DIR", 500000]],
    sips: [["AXIS_BLUE_REG", "STOP", 10000], ["PGIM_FLEXI_REG", "STOP", 5000], ["HDFC_FLEXI_DIR", "START", 7500], ["BANDHAN_SMALL_DIR", "START", 5000], ["MOSL_LARGEMID_DIR", "START", 2500]],
  });
  const b1 = await call("rohan", c1, at(3, 10, 42), "PHONE", [["AXIS_BLUE_REG", "SELL", 1000000], ["PGIM_FLEXI_REG", "SELL", 800000]], "First tranche of exits; markets near highs.");
  const b2 = await call("rohan", c1, at(2, 11, 15), "WHATSAPP", [["NIPPON_SILVER_REG", "SELL", 500000], ["HDFC_FLEXI_DIR", "BUY", 800000]]);
  await as("rohan", (tx) => reviseAdvice(tx, users.rohan, {
    adviceItemId: b2.itemIds[0], newTotalAmount: 200000, reason: "Silver rallied 4% intraday — staggering the exit",
    communicatedAt: at(2, 15, 5), channel: "PHONE",
  }));
  const b3 = await call("rohan", c1, at(2, 15, 30), "PHONE", [["PGIM_FLEXI_REG", "SELL", 300000]]);
  await as("rohan", (tx) => closeAdvice(tx, b3.itemIds[0], "CANCELLED", "Client wants to wait for the IDCW record date"));
  const b4 = await call("rohan", c1, at(1, 10, 5), "IN_PERSON", [["ABSL_DIGITAL_REG", "SELL", 500000], ["MOSL_LARGEMID_DIR", "BUY", 500000]]);
  await call("rohan", c1, minutesAgo(90), "PHONE", [["NIPPON_MULTIASSET_DIR", "BUY", 200000]], "Deploy first multi-asset tranche.");
  await execute("rohan", b1.itemIds[0], 2, 600000, "CLIENT_CONFIRMED", undefined, "Redeemed via distributor app");
  await execute("neha", b1.itemIds[0], 1, 400000, "ADVISOR_CONFIRMED");
  await execute("neha", b1.itemIds[1], 1, 500000, "PROOF_VERIFIED", undefined, "Redemption confirmation email received");
  await execute("rohan", b4.itemIds[0], 0, 300000, "CLIENT_CONFIRMED");
  await execute("neha", b2.itemIds[1], 1, 800000, "PROOF_VERIFIED");
  await execute("neha", b4.itemIds[1], 0, 400000, "CLIENT_CONFIRMED", undefined, "Client will add the balance next week");
  const sipRows = await sql<{ id: string; scheme_name: string; action: string }[]>`
    select id, scheme_name, action from public.sip_plan_items where client_id = ${c1}`;
  for (const s of sipRows) {
    if (s.action === "STOP" && s.scheme_name.startsWith("Axis")) await as("neha", (tx) => setSipStatus(tx, s.id, "COMPLETED", "Mandate cancelled, confirmed by AMC"));
    if (s.action === "STOP" && s.scheme_name.startsWith("PGIM")) await as("rohan", (tx) => setSipStatus(tx, s.id, "ADVISED", "Asked client to cancel mandate"));
    if (s.action === "START" && s.scheme_name.startsWith("HDFC")) await as("neha", (tx) => setSipStatus(tx, s.id, "COMPLETED", "First instalment registered"));
  }
  await as("rohan", (tx) => addNote(tx, users.rohan, { clientId: c1, noteType: "CALL_LOG", body: "Walked the client through the staggered exit plan. Comfortable with 3-4 tranches over two weeks." }));
  await as("rohan", (tx) => addNote(tx, users.rohan, { clientId: c1, noteType: "FOLLOW_UP", body: "Confirm Axis balance redemption and PGIM tranche.", followUpDate: istDate(0) }));
  console.log("C1 (₹1 crore scenario) done");

  // ===== C2: CAS reconciliation example ================================================
  const c2 = await newClient("rohan", {
    name: "Meera Kapoor", email: "meera.kapoor@example.com", phone: "+91 98200 11002", pan: "BCDPK2345L",
    risk: "MODERATE", goal: "Child education fund (2034)", status: "ACTIVE", onboardedDaysAgo: 42,
  });
  const c2snap = await baselineSnapshot("rohan", c2, "c2", istDate(40), [
    ["PGIM_FLEXI_REG", 1000, 250], ["NIPPON_SMALL_REG", 2000, 150], ["KOTAK_EMERGING_DIR", 500, 120], ["UTI_NIFTY_DIR", 3000, 160],
  ]);
  await activePlan("rohan", c2, c2snap, {
    approvedDaysAgo: 35,
    sells: [["PGIM_FLEXI_REG", 250000], ["NIPPON_SMALL_REG", 150000]],
    buys: [["PPFAS_FLEXI_DIR", 250000], ["HDFC_CORPBOND_DIR", 150000]],
  });
  const c2b1 = await call("rohan", c2, at(12, 11, 0), "PHONE", [["PGIM_FLEXI_REG", "SELL", 100000, 400, 250]], "Sell 400 units first.");
  const c2b2 = await call("rohan", c2, at(10, 12, 30), "WHATSAPP", [["PPFAS_FLEXI_DIR", "BUY", 100000]]);
  await execute("rohan", c2b2.itemIds[0], 9, 100000, "CLIENT_CONFIRMED", undefined, "Client says purchase done");
  void c2b1;
  // Operations uploads the new CAS (file itself not stored in seed).
  const c2cas = await as("neha", (tx) => registerCasDocument(tx, users.neha.id, {
    clientId: c2, fileName: "CAS_Meera_Kapoor_latest.pdf", mimeType: "application/pdf", sizeBytes: 182_000,
    sha256: "a".repeat(63) + "1", filePath: `${c2}/CAS/seed-placeholder.pdf`, source: "CAMS", passwordProtected: true,
    notes: "Seed placeholder — no file in storage",
  }));
  const c2parsed = parsed("c2", istDate(2), [
    ["PGIM_FLEXI_REG", 600, 255], ["NIPPON_SMALL_REG", 1333.333, 152], ["KOTAK_EMERGING_DIR", 520, 121],
    ["UTI_NIFTY_DIR", 3000, 162], ["PPFAS_FLEXI_DIR", 1250, 80.5],
  ], [
    { date: istDate(8), type: "REDEMPTION", scheme_name: sec.PGIM_FLEXI_REG.name, isin: sec.PGIM_FLEXI_REG.isin, folio_number: folio("c2", "PGIM_FLEXI_REG"), units: -400, nav: 254, amount: -101600, balance_units: 600 },
    { date: istDate(6), type: "REDEMPTION", scheme_name: sec.NIPPON_SMALL_REG.name, isin: sec.NIPPON_SMALL_REG.isin, folio_number: folio("c2", "NIPPON_SMALL_REG"), units: -666.667, nav: 151, amount: -100667, balance_units: 1333.333 },
    { date: istDate(33), type: "SIP", scheme_name: sec.KOTAK_EMERGING_DIR.name, isin: sec.KOTAK_EMERGING_DIR.isin, folio_number: folio("c2", "KOTAK_EMERGING_DIR"), units: 10, nav: 118, amount: 1180, balance_units: 510 },
    { date: istDate(3), type: "SIP", scheme_name: sec.KOTAK_EMERGING_DIR.name, isin: sec.KOTAK_EMERGING_DIR.isin, folio_number: folio("c2", "KOTAK_EMERGING_DIR"), units: 10, nav: 120, amount: 1200, balance_units: 520 },
    { date: istDate(9), type: "PURCHASE", scheme_name: sec.PPFAS_FLEXI_DIR.name, isin: sec.PPFAS_FLEXI_DIR.isin, folio_number: folio("c2", "PPFAS_FLEXI_DIR"), units: 1250, nav: 80, amount: 100000, balance_units: 1250 },
  ]);
  const ingest = await withSystemTx("seed:n8n-simulated", (tx) => ingestCasParseResult(tx, { ...c2parsed, cas_document_id: c2cas.casDocumentId }, null), { sql });
  await as("neha", async (tx) => {
    await confirmSnapshot(tx, ingest.snapshotId!, "Totals verified against PDF");
    await runReconciliation(tx, users.neha, { clientId: c2, currentSnapshotId: ingest.snapshotId! });
  });
  console.log("C2 (reconciliation) done");

  // ===== C3: today's activity ===========================================================
  const c3 = await newClient("priya", {
    name: "Vikram Sethi", email: "vikram.sethi@example.com", phone: "+91 98200 11003", pan: "CDEPS3456M",
    risk: "AGGRESSIVE", goal: "Early retirement at 50", status: "ACTIVE", onboardedDaysAgo: 22,
  });
  const c3snap = await baselineSnapshot("priya", c3, "c3", istDate(20), [
    ["SBI_FOCUS_REG", 4000, 300], ["ICICI_BLUE_REG", 9000, 100], ["MIRAE_ELSS_REG", 5000, 120], ["UTI_NIFTY_DIR", 5000, 160],
  ]);
  await activePlan("priya", c3, c3snap, {
    approvedDaysAgo: 15,
    sells: [["SBI_FOCUS_REG", 1200000], ["ICICI_BLUE_REG", 900000]],
    buys: [["PPFAS_FLEXI_DIR", 1000000], ["EDEL_MID_DIR", 600000], ["HDFC_FLEXI_DIR", 500000]],
  });
  const c3old = await call("priya", c3, at(4, 14, 20), "PHONE", [["EDEL_MID_DIR", "BUY", 300000]]);
  await execute("priya", c3old.itemIds[0], 3, 300000, "PROOF_VERIFIED");
  const c3today = await call("priya", c3, minutesAgo(150), "PHONE",
    [["SBI_FOCUS_REG", "SELL", 600000], ["ICICI_BLUE_REG", "SELL", 400000], ["PPFAS_FLEXI_DIR", "BUY", 500000]], "Morning call — first tranche.");
  await execute("neha", c3today.itemIds[0], 0, 600000, "CLIENT_CONFIRMED");
  await execute("neha", c3today.itemIds[2], 0, 250000, "CLIENT_CONFIRMED", undefined, "Half deployed, rest after proceeds arrive");
  console.log("C3 done");

  // ===== C4: advisory report extracted to a DRAFT plan (needs review) ==================
  const c4 = await newClient("priya", {
    name: "Sneha Kulkarni", email: "sneha.kulkarni@example.com", phone: "+91 98200 11004",
    risk: "MODERATE", goal: "Wealth creation", status: "ONBOARDING", onboardedDaysAgo: 7,
  });
  await baselineSnapshot("priya", c4, "c4", istDate(6), [
    ["MM_MULTI_REG", 5000, 40], ["NIPPON_SILVER_REG", 17000, 17.65], ["MIRAE_ELSS_REG", 1250, 120],
  ]);
  const c4code = (await sql<{ client_code: string }[]>`select client_code from public.clients where id = ${c4}`)[0].client_code;
  await withSystemTx("seed:n8n-simulated", (tx) => ingestAdvisoryReport(tx, {
    client_code: c4code, status: "PARSED", document_id: null, error: null,
    plan: { plan_name: "Portfolio rebalancing & execution report", plan_date: istDate(1), starting_portfolio_value: 650050, notes: "Extracted from advisory report PDF." },
    items: [
      { action: "SWITCH", scheme_name: "Mahindra Manulife Multi Cap Fund (Reg)", target_amount: 200000, current_amount: 200000, reason: "Same fund, move Regular to Direct", isin: null, folio_number: null, target_units: null, target_weight: null, priority: 10, switch_to_scheme_name: "Mahindra Manulife Multi Cap Fund (Direct)" },
      { action: "SELL", scheme_name: "Nippon India Silver ETF FoF (Reg)", target_amount: 300050, current_amount: 300050, reason: "Silver is a hedge, not a growth engine", isin: null, folio_number: null, target_units: null, target_weight: null, priority: 20, switch_to_scheme_name: null },
      { action: "RETAIN", scheme_name: "Mirae Asset ELSS Tax Saver Fund - Regular", target_amount: 0, current_amount: 150000, reason: "Lock-in until 2027", isin: null, folio_number: null, target_units: null, target_weight: null, priority: 30, switch_to_scheme_name: null },
      { action: "BUY", scheme_name: "Mahindra Manulife Multi Cap Fund - Direct Growth", target_amount: 250000, reason: "Top-ranked multi cap", isin: null, folio_number: null, target_units: null, current_amount: null, target_weight: 38.5, priority: 40, switch_to_scheme_name: null },
      { action: "BUY", scheme_name: "Edelweiss Mid Cap Direct", target_amount: 150050, reason: "Core mid cap", isin: null, folio_number: null, target_units: null, current_amount: null, target_weight: 23.1, priority: 50, switch_to_scheme_name: null },
      { action: "BUY", scheme_name: "Zenith Innovation Opportunities Fund Direct", target_amount: 100000, reason: "Thematic satellite", isin: null, folio_number: null, target_units: null, current_amount: null, target_weight: 15.4, priority: 60, switch_to_scheme_name: null },
    ],
    sip_items: [
      { action: "STOP", scheme_name: "Mahindra Manulife Multi Cap Fund (Reg)", old_amount: 2500, new_amount: null, frequency: "MONTHLY", debit_day: 8, isin: null, folio_number: null, notes: null },
      { action: "START", scheme_name: "Mahindra Manulife Multi Cap Fund - Direct Growth", old_amount: null, new_amount: 1500, frequency: "MONTHLY", debit_day: 8, isin: null, folio_number: null, notes: null },
      { action: "START", scheme_name: "Edelweiss Mid Cap Fund - Direct Growth", old_amount: null, new_amount: 1000, frequency: "MONTHLY", debit_day: 8, isin: null, folio_number: null, notes: null },
    ],
    declared_totals: { exit_value: 500050, buy_value: 500050, sip_value: 2500 },
    warnings: ["Scheme 'Zenith Innovation Opportunities Fund' not found in the security master."],
  }, null), { sql });
  console.log("C4 (draft plan from extraction) done");

  // ===== C5: stale pending executions ===================================================
  const c5 = await newClient("karan", {
    name: "Rahul Bhatia", email: "rahul.bhatia@example.com", phone: "+91 98200 11005", pan: "DEFPB4567N",
    risk: "MODERATE", goal: "House purchase in 2029", status: "ACTIVE", onboardedDaysAgo: 32, reviewInDays: 2,
  });
  const c5snap = await baselineSnapshot("karan", c5, "c5", istDate(30), [
    ["AXIS_BLUE_REG", 24000, 62.5], ["PPFAS_FLEXI_REG", 13333.333, 75], ["HDFC_CORPBOND_DIR", 16666.667, 30],
  ]);
  await activePlan("karan", c5, c5snap, {
    approvedDaysAgo: 25,
    sells: [["AXIS_BLUE_REG", 1500000], ["PPFAS_FLEXI_REG", 1000000, "SWITCH"]],
    buys: [["AXIS_BLUE_DIR", 800000], ["PPFAS_FLEXI_DIR", 1000000], ["UTI_NIFTY_DIR", 700000]],
  });
  const c5b1 = await call("karan", c5, at(7, 16, 10), "EMAIL", [["AXIS_BLUE_REG", "SELL", 800000], ["PPFAS_FLEXI_REG", "SWITCH", 1000000]]);
  await execute("karan", c5b1.itemIds[1], 5, 1000000, "PROOF_VERIFIED", undefined, "Switch statement attached by client");
  await call("karan", c5, at(4, 11, 45), "PHONE", [["PPFAS_FLEXI_DIR", "BUY", 1000000]]);
  await as("karan", (tx) => addNote(tx, users.karan, { clientId: c5, noteType: "FOLLOW_UP", body: "Client has not redeemed Axis yet — follow up.", followUpDate: istDate(1) }));
  console.log("C5 done");

  // ===== C6: onboarding, CAS needs review ==============================================
  const c6 = await newClient("karan", {
    name: "Ananya Desai", email: "ananya.desai@example.com", phone: "+91 98200 11006",
    risk: "CONSERVATIVE", goal: "Capital preservation with modest growth", status: "ONBOARDING", onboardedDaysAgo: 2,
  });
  const c6cas = await as("neha", (tx) => registerCasDocument(tx, users.neha.id, {
    clientId: c6, fileName: "CAS_Ananya_Desai.pdf", mimeType: "application/pdf", sizeBytes: 240_000,
    sha256: "b".repeat(63) + "2", filePath: `${c6}/CAS/seed-placeholder.pdf`, source: "KFINTECH", passwordProtected: true,
  }));
  const c6parsed = parsed("c6", istDate(1), [["HDFC_CORPBOND_DIR", 20000, 30], ["ICICI_LIQUID_DIR", 50, 4000], ["UTI_NIFTY_DIR", 1500, 162]]);
  await withSystemTx("seed:n8n-simulated", (tx) => ingestCasParseResult(tx, {
    ...c6parsed, cas_document_id: c6cas.casDocumentId, extraction_method: "AI_EXTRACTION",
    totals: { current_value: 1050000, invested_value: null },
  }, null), { sql });
  console.log("C6 done");

  // ===== C7: transition complete =======================================================
  const c7 = await newClient("rohan", {
    name: "Farhan Qureshi", email: "farhan.qureshi@example.com", phone: "+91 98200 11007", pan: "EFGPQ5678P",
    risk: "MODERATELY_AGGRESSIVE", goal: "Wealth creation", status: "ACTIVE", onboardedDaysAgo: 62,
  });
  const c7snap = await baselineSnapshot("rohan", c7, "c7", istDate(60), [["ICICI_BLUE_REG", 5000, 100], ["NIPPON_SMALL_REG", 2000, 150]]);
  await activePlan("rohan", c7, c7snap, {
    approvedDaysAgo: 55,
    sells: [["ICICI_BLUE_REG", 500000], ["NIPPON_SMALL_REG", 300000]],
    buys: [["UTI_NIFTY_DIR", 500000], ["BANDHAN_SMALL_DIR", 300000]],
  });
  const c7b = await call("rohan", c7, at(50, 10, 30), "PHONE", [["ICICI_BLUE_REG", "SELL", 500000], ["NIPPON_SMALL_REG", "SELL", 300000]]);
  const c7c = await call("rohan", c7, at(47, 10, 30), "PHONE", [["UTI_NIFTY_DIR", "BUY", 500000], ["BANDHAN_SMALL_DIR", "BUY", 300000]]);
  await execute("neha", c7b.itemIds[0], 48, 502100, "PROOF_VERIFIED");
  await execute("neha", c7b.itemIds[1], 48, 298900, "PROOF_VERIFIED", undefined, "NAV moved slightly; within tolerance");
  await execute("neha", c7c.itemIds[0], 46, 500000, "PROOF_VERIFIED");
  await execute("neha", c7c.itemIds[1], 46, 300000, "PROOF_VERIFIED");
  console.log("C7 done");

  // ===== C8: dormant, review overdue ===================================================
  const c8 = await newClient("priya", {
    name: "Kavita Nair", email: "kavita.nair@example.com", phone: "+91 98200 11008",
    risk: "CONSERVATIVE", goal: "Retirement income", status: "DORMANT", onboardedDaysAgo: 400, reviewInDays: -3,
  });
  await baselineSnapshot("priya", c8, "c8", istDate(200), [["HDFC_CORPBOND_DIR", 20000, 30], ["UTI_NIFTY_DIR", 2500, 160]]);
  console.log("C8 done");

  // ===== C9: unit-based calls with multiple partial executions =========================
  const c9 = await newClient("karan", {
    name: "Siddharth Rao", email: "siddharth.rao@example.com", phone: "+91 98200 11009", pan: "FGHPR6789Q",
    risk: "MODERATE", goal: "Wealth creation", status: "ACTIVE", onboardedDaysAgo: 21,
  });
  const c9snap = await baselineSnapshot("karan", c9, "c9", istDate(20), [
    ["AXIS_BLUE_REG", 1500, 50], ["MIRAE_ELSS_REG", 2000, 110], ["HDFC_FLEXI_REG", 400, 1900],
  ]);
  await activePlan("karan", c9, c9snap, {
    approvedDaysAgo: 18,
    sells: [["AXIS_BLUE_REG", 75000, "SELL", 1500], ["HDFC_FLEXI_REG", 760000]],
    buys: [["HDFC_FLEXI_DIR", 760000], ["AXIS_BLUE_DIR", 75000]],
  });
  const c9b = await call("karan", c9, at(5, 10, 0), "PHONE", [["AXIS_BLUE_REG", "SELL", 25000, 500, 50]], "Sell 500 units.");
  await execute("karan", c9b.itemIds[0], 4, 10100, "CLIENT_CONFIRMED", 200);
  await execute("neha", c9b.itemIds[0], 3, 15300, "PROOF_VERIFIED", 300);
  const c9c = await call("karan", c9, at(3, 12, 0), "WHATSAPP", [["HDFC_FLEXI_REG", "SELL", 380000, 200, 1900]]);
  await execute("neha", c9c.itemIds[0], 2, 230400, "PROOF_VERIFIED", 120);
  console.log("C9 done");

  // ===== C10: prospect ===================================================================
  await newClient("rohan", {
    name: "Pooja Agarwal", email: "pooja.agarwal@example.com", phone: "+91 98200 11010",
    risk: "MODERATELY_AGGRESSIVE", goal: "First-time investor; SIP-led wealth creation", status: "PROSPECT", onboardedDaysAgo: 0,
  });
  console.log("C10 done");

  console.log("\nSeed complete. Sign in with any demo user and SEED_DEMO_PASSWORD:");
  for (const u of USERS) console.log(`  ${u.role.padEnd(11)} ${u.email}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
