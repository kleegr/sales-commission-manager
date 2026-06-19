// Dependency-free, DB-free tests for the server-side commission recompute core.
// Run via `tsx api/_lib/recompute.test.ts` (wired into `npm test`).
//
// These cover the heart of the slice: turning payments + a plan into ledger
// rows, honoring timing (hold / release / clawback), and — critically —
// preserving locked payout rows so payout history is never corrupted.
import {
  recomputeClientLedger,
  isLocked,
  isManual,
  type PriorLedgerRow,
} from "./recompute.js";
import type {
  Client,
  CommissionEntry,
  CommissionPlan,
  CommissionTiming,
  Payment,
  Salesperson,
} from "../../src/types/index.js";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    console.log(`  \u2717 ${name}`);
  }
}

// ---- fixtures --------------------------------------------------------------

const TODAY = "2025-06-01";

function plan(timing?: CommissionTiming): CommissionPlan {
  return {
    id: "plan1",
    name: "Test",
    description: "",
    rules: [
      { id: "r_setup", type: "setup_fee", mode: "percentage", value: 10 },
      { id: "r_bonus", type: "signup_bonus", amount: 100 },
      { id: "r_res", type: "monthly_residual", startMonth: 1, endMonth: null, continueForever: true, valueType: "percentage", value: 50 },
    ],
    sampleSetupFee: 1000,
    sampleMonthly: 200,
    timing,
    createdAt: "2025-01-01",
  };
}

const sp: Salesperson = {
  id: "sp1", name: "Rep", email: "", phone: "", role: "salesperson", referralCode: "",
  status: "active", commissionPlanId: "plan1", weeklySalary: null, salaryStartDate: null,
  salaryEndDate: null, notes: "", source: "admin", approvalStatus: "approved", createdAt: "2025-01-01",
};

function client(over: Partial<Client> = {}): Client {
  return {
    id: "cl1", companyName: "Acme", contactName: "", email: "", phone: "",
    salespersonId: "sp1", signupDate: "2025-01-01", setupFee: 1000, monthlySubscription: 200,
    status: "active", canceledDate: null, notes: "", createdAt: "2025-01-01", ...over,
  };
}

const setupPay: Payment = { id: "p_setup", clientId: "cl1", date: "2025-01-01", type: "setup_fee", amount: 1000, paymentNumber: null, notes: "", createdAt: "2025-01-01" };
const monthlyPay: Payment = { id: "p_m1", clientId: "cl1", date: "2025-01-01", type: "monthly_subscription", amount: 200, paymentNumber: 1, notes: "", createdAt: "2025-01-01" };

const findByRule = (rows: CommissionEntry[], ruleId: string) => rows.filter((r) => r.ruleId === ruleId);

// ---- status classification -------------------------------------------------

console.log("\n[Recompute \u00b7 status classification]");
ok("paid is locked", isLocked("paid"));
ok("submitted is locked", isLocked("submitted"));
ok("approved is locked", isLocked("approved"));
ok("pending NOT locked", !isLocked("pending"));
ok("held NOT locked", !isLocked("held"));
ok("rejected is manual", isManual("rejected"));
ok("canceled is manual", isManual("canceled"));
ok("pending NOT manual", !isManual("pending"));

// ---- fresh recompute (immediate timing) ------------------------------------

console.log("\n[Recompute \u00b7 fresh, pay-immediately]");
{
  const r = recomputeClientLedger({ client: client(), salesperson: sp, plan: plan(), payments: [setupPay, monthlyPay], priorRows: [], today: TODAY });
  ok("no prior rows -> nothing deleted/preserved", r.deleteIds.length === 0 && r.preservedIds.length === 0);
  ok("three rows generated", r.insertRows.length === 3);
  const setup = findByRule(r.insertRows, "r_setup")[0];
  const bonus = findByRule(r.insertRows, "r_bonus")[0];
  const res = findByRule(r.insertRows, "r_res")[0];
  ok("setup = 10% of 1000 = 100", !!setup && setup.commissionAmount === 100);
  ok("signup bonus = 100", !!bonus && bonus.commissionAmount === 100);
  ok("residual = 50% of 200 = 100", !!res && res.commissionAmount === 100);
  ok("all pending under immediate timing", r.insertRows.every((e) => e.status === "pending"));
  ok("rows carry the payment id", r.insertRows.every((e) => e.paymentId === "p_setup" || e.paymentId === "p_m1"));
}

// ---- locked row is preserved, never regenerated ----------------------------

console.log("\n[Recompute \u00b7 locked payout protection]");
{
  const prior: PriorLedgerRow[] = [
    { id: "led_paid", paymentId: "p_setup", ruleId: "r_setup", status: "paid", paidDate: "2025-02-01", releasedOverride: false },
  ];
  const r = recomputeClientLedger({ client: client(), salesperson: sp, plan: plan(), payments: [setupPay, monthlyPay], priorRows: prior, today: TODAY });
  ok("paid row preserved", r.preservedIds.includes("led_paid"));
  ok("paid row NOT deleted", !r.deleteIds.includes("led_paid"));
  ok("setup line NOT regenerated (locked owns it)", findByRule(r.insertRows, "r_setup").length === 0);
  ok("other lines still generated", findByRule(r.insertRows, "r_bonus").length === 1 && findByRule(r.insertRows, "r_res").length === 1);
}

// even if the plan rate changes, a locked row is untouched (not in inserts)
{
  const cheaper = plan();
  (cheaper.rules[0] as any).value = 1; // setup now 1% — must NOT affect the paid row
  const prior: PriorLedgerRow[] = [
    { id: "led_paid", paymentId: "p_setup", ruleId: "r_setup", status: "paid", paidDate: "2025-02-01", releasedOverride: false },
  ];
  const r = recomputeClientLedger({ client: client(), salesperson: sp, plan: cheaper, payments: [setupPay], priorRows: prior, today: TODAY });
  ok("plan rate change cannot re-price a paid row", findByRule(r.insertRows, "r_setup").length === 0 && r.preservedIds.includes("led_paid"));
}

// ---- non-locked rows are regenerated; released_override is sticky ----------

console.log("\n[Recompute \u00b7 regenerate + sticky release]");
{
  const onApproval: CommissionTiming = { trigger: "on_approval", days: 0, months: 0, payments: 0, requireActiveClient: false, clawbackBeforeMonths: 0 };
  // held residual with a prior admin release flag
  const prior: PriorLedgerRow[] = [
    { id: "led_held", paymentId: "p_m1", ruleId: "r_res", status: "held", paidDate: null, releasedOverride: true },
  ];
  const r = recomputeClientLedger({ client: client(), salesperson: sp, plan: plan(onApproval), payments: [monthlyPay], priorRows: prior, today: TODAY });
  ok("prior held row deleted (regenerated)", r.deleteIds.includes("led_held"));
  const res = findByRule(r.insertRows, "r_res")[0];
  ok("released_override carried across by key", !!res && res.releasedOverride === true);
  ok("released override -> pending despite on_approval", !!res && res.status === "pending");
}
{
  const onApproval: CommissionTiming = { trigger: "on_approval", days: 0, months: 0, payments: 0, requireActiveClient: false, clawbackBeforeMonths: 0 };
  const r = recomputeClientLedger({ client: client(), salesperson: sp, plan: plan(onApproval), payments: [monthlyPay], priorRows: [], today: TODAY });
  const res = findByRule(r.insertRows, "r_res")[0];
  ok("on_approval with no release -> held", !!res && res.status === "held");
}

// ---- clawback wins ---------------------------------------------------------

console.log("\n[Recompute \u00b7 clawback]");
{
  const t: CommissionTiming = { trigger: "immediate", days: 0, months: 0, payments: 0, requireActiveClient: false, clawbackBeforeMonths: 6 };
  const canceled = client({ status: "canceled", canceledDate: "2025-03-01" }); // ~2 months after signup
  const r = recomputeClientLedger({ client: canceled, salesperson: sp, plan: plan(t), payments: [setupPay], priorRows: [], today: TODAY });
  const setup = findByRule(r.insertRows, "r_setup")[0];
  ok("canceled inside window -> clawed_back", !!setup && setup.status === "clawed_back");
  ok("clawback reason present", !!setup && !!setup.clawbackReason);
}

// ---- require-active-client hold --------------------------------------------

console.log("\n[Recompute \u00b7 active-client + after_payments holds]");
{
  const t: CommissionTiming = { trigger: "immediate", days: 0, months: 0, payments: 0, requireActiveClient: true, clawbackBeforeMonths: 0 };
  const paused = client({ status: "paused" });
  const r = recomputeClientLedger({ client: paused, salesperson: sp, plan: plan(t), payments: [monthlyPay], priorRows: [], today: TODAY });
  const res = findByRule(r.insertRows, "r_res")[0];
  ok("inactive client -> held (active-only)", !!res && res.status === "held");
}
{
  const t: CommissionTiming = { trigger: "after_payments", days: 0, months: 0, payments: 2, requireActiveClient: false, clawbackBeforeMonths: 0 };
  // only ONE monthly payment present -> below the threshold -> held
  const r = recomputeClientLedger({ client: client(), salesperson: sp, plan: plan(t), payments: [monthlyPay], priorRows: [], today: TODAY });
  const res = findByRule(r.insertRows, "r_res")[0];
  ok("after_payments 2 with 1 paid -> held", !!res && res.status === "held");
}
{
  const t: CommissionTiming = { trigger: "after_payments", days: 0, months: 0, payments: 2, requireActiveClient: false, clawbackBeforeMonths: 0 };
  const m2: Payment = { ...monthlyPay, id: "p_m2", paymentNumber: 2, date: "2025-02-01" };
  const r = recomputeClientLedger({ client: client(), salesperson: sp, plan: plan(t), payments: [monthlyPay, m2], priorRows: [], today: TODAY });
  // two residual lines now released
  ok("after_payments 2 with 2 paid -> pending", findByRule(r.insertRows, "r_res").every((e) => e.status === "pending"));
}

// ---- no plan / unassigned: drop non-locked, keep locked, insert nothing ----

console.log("\n[Recompute \u00b7 unassigned client]");
{
  const prior: PriorLedgerRow[] = [
    { id: "led_pending", paymentId: "p_m1", ruleId: "r_res", status: "pending", paidDate: null, releasedOverride: false },
    { id: "led_paid", paymentId: "p_setup", ruleId: "r_setup", status: "paid", paidDate: "2025-02-01", releasedOverride: false },
  ];
  const r = recomputeClientLedger({ client: client(), salesperson: null, plan: null, payments: [setupPay, monthlyPay], priorRows: prior, today: TODAY });
  ok("no plan -> non-locked deleted", r.deleteIds.includes("led_pending"));
  ok("no plan -> locked preserved", r.preservedIds.includes("led_paid") && !r.deleteIds.includes("led_paid"));
  ok("no plan -> nothing inserted", r.insertRows.length === 0);
}
{
  // salesperson id mismatch (client reassigned) is treated as unassigned
  const otherSp: Salesperson = { ...sp, id: "spX" };
  const r = recomputeClientLedger({ client: client(), salesperson: otherSp, plan: plan(), payments: [setupPay], priorRows: [], today: TODAY });
  ok("salesperson mismatch -> nothing inserted", r.insertRows.length === 0);
}

console.log(`\n========================\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
