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
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}`);
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

console.log("\n[Recompute · status classification]");
ok("paid is locked", isLocked("paid"));
ok("submitted is locked", isLocked("submitted"));
ok("approved is locked", isLocked("approved"));
ok("pending NOT locked", !isLocked("pending"));
ok("held NOT locked", !isLocked("held"));
ok("rejected is manual", isManual("rejected"));
ok("canceled is manual", isManual("canceled"));
ok("pending NOT manual", !isManual("pending"));

// ---- fresh recompute (immediate timing) ------------------------------------

console.log("\n[Recompute · fresh, pay-immediately]");
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

console.log("\n[Recompute · locked payout protection]");
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

console.log("\n[Recompute · regenerate + sticky release]");
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

console.log("\n[Recompute · clawback]");
{
  const t: CommissionTiming = { trigger: "immediate", days: 0, months: 0, payments: 0, requireActiveClient: false, clawbackBeforeMonths: 6 };
  const canceled = client({ status: "canceled", canceledDate: "2025-03-01" }); // ~2 months after signup
  const r = recomputeClientLedger({ client: canceled, salesperson: sp, plan: plan(t), payments: [setupPay], priorRows: [], today: TODAY });
  const setup = findByRule(r.insertRows, "r_setup")[0];
  ok("canceled inside window -> clawed_back", !!setup && setup.status === "clawed_back");
  ok("clawback reason present", !!setup && !!setup.clawbackReason);
}

// ---- require-active-client hold --------------------------------------------

console.log("\n[Recompute · active-client + after_payments holds]");
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

// ---- prior row ids preserved by their stable payment+rule key --------------

console.log("\n[Recompute · id preservation]");
{
  const prior: PriorLedgerRow[] = [
    { id: "led_res_keep", paymentId: "p_m1", ruleId: "r_res", status: "pending", paidDate: null, releasedOverride: false },
  ];
  const r = recomputeClientLedger({ client: client(), salesperson: sp, plan: plan(), payments: [monthlyPay], priorRows: prior, today: TODAY });
  ok("prior non-locked row deleted before reinsert", r.deleteIds.includes("led_res_keep"));
  const res = findByRule(r.insertRows, "r_res")[0];
  ok("regenerated row keeps the EXISTING id (stable key)", !!res && res.id === "led_res_keep");
}

// ---- locked rows get an offsetting NEGATIVE entry when clawback applies -----

console.log("\n[Recompute · locked-row clawback offset]");
{
  const t: CommissionTiming = { trigger: "immediate", days: 0, months: 0, payments: 0, requireActiveClient: false, clawbackBeforeMonths: 6 };
  const canceled = client({ status: "canceled", canceledDate: "2025-03-01" }); // ~2 months < 6
  const prior: PriorLedgerRow[] = [
    { id: "led_paid", paymentId: "p_setup", ruleId: "r_setup", status: "paid", paidDate: "2025-02-01", releasedOverride: false, commissionAmount: 100, ruleType: "setup_fee" },
  ];
  const r = recomputeClientLedger({ client: canceled, salesperson: sp, plan: plan(t), payments: [setupPay], priorRows: prior, today: TODAY });
  ok("locked row still preserved", r.preservedIds.includes("led_paid") && !r.deleteIds.includes("led_paid"));
  const offset = r.insertRows.find((e) => e.id === "cb_led_paid");
  ok("offsetting clawback entry created", !!offset);
  ok("offset amount is the negative of the locked amount", !!offset && offset.commissionAmount === -100);
  ok("offset is a payable (pending) recovery line", !!offset && offset.status === "pending");
  ok("offset carries the clawback reason", !!offset && !!offset.notes);

  // outside the window -> no offset
  const survived = client({ status: "canceled", canceledDate: "2025-01-01" });
  const late = { ...survived, canceledDate: "2025-12-01" };
  const r2 = recomputeClientLedger({ client: late, salesperson: sp, plan: plan(t), payments: [setupPay], priorRows: prior, today: "2026-01-01" });
  ok("no offset when cancel is outside the window", !r2.insertRows.some((e) => e.id === "cb_led_paid"));

  // once the offset itself is locked (e.g. submitted), it is never duplicated
  const priorWithLockedOffset: PriorLedgerRow[] = [
    ...prior,
    { id: "cb_led_paid", paymentId: "p_setup", ruleId: "r_setup", status: "submitted", paidDate: null, releasedOverride: false, commissionAmount: -100, ruleType: "setup_fee" },
  ];
  const r3 = recomputeClientLedger({ client: canceled, salesperson: sp, plan: plan(t), payments: [setupPay], priorRows: priorWithLockedOffset, today: TODAY });
  ok("locked offset preserved, not regenerated", r3.preservedIds.includes("cb_led_paid") && !r3.insertRows.some((e) => e.id === "cb_led_paid"));
}

// ---- no plan / unassigned: drop non-locked, keep locked, insert nothing ----

console.log("\n[Recompute · unassigned client]");
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
