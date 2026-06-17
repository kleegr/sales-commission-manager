// Lightweight test runner (no framework). Run with: npm test
// Verifies the engine against the exact examples in the project spec.

import {
  calculateCommissionForPayment,
  projectBook,
  projectPlanForClient,
  suggestNextStartMonth,
} from "./commission-engine";
import type {
  Client,
  CommissionPlan,
  MonthlyResidualRule,
  Payment,
  Salesperson,
} from "../types";

let passed = 0;
let failed = 0;

function approx(a: number, b: number, eps = 0.01): boolean {
  return Math.abs(a - b) <= eps;
}
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`, extra ?? "");
  }
}

function residual(
  startMonth: number,
  endMonth: number | null,
  value: number,
  valueType: "percentage" | "fixed" = "percentage",
  continueForever = false,
): MonthlyResidualRule {
  return {
    id: `r_${startMonth}_${endMonth ?? "fwd"}`,
    type: "monthly_residual",
    startMonth,
    endMonth,
    continueForever,
    valueType,
    value,
  };
}

function plan(rules: CommissionPlan["rules"]): CommissionPlan {
  return {
    id: "p1",
    name: "Test",
    description: "",
    rules,
    sampleSetupFee: 2500,
    sampleMonthly: 250,
    createdAt: "2025-01-01",
  };
}

console.log("\nCommission engine tests\n========================");

// --- Month 1 combined example: 50% of $2,500 setup + 60% of $250 = $1,400 ---
{
  const p = plan([
    { id: "s", type: "setup_fee", mode: "percentage", value: 50 },
    residual(1, 1, 60),
  ]);
  const proj = projectPlanForClient(p, { setupFee: 2500, monthlySubscription: 250 });
  console.log("\n[Month 1 combined]");
  check("setup fee commission = $1,250", approx(proj.setupFeeCommission, 1250), proj.setupFeeCommission);
  check("month 1 total = $1,400", approx(proj.months[0].total, 1400), proj.months[0].total);
  check("month 1 shows 2 lines (setup + residual)", proj.months[0].lines.length === 2, proj.months[0].lines.length);
}

// --- Example A: tiered down then 4% forever ---
{
  const p = plan([
    residual(1, 1, 70),
    residual(2, 2, 60),
    residual(3, 3, 50),
    residual(4, 4, 40),
    residual(5, 5, 30),
    residual(6, 6, 20),
    residual(7, null, 4, "percentage", true),
  ]);
  const proj = projectPlanForClient(p, { setupFee: 0, monthlySubscription: 250 });
  console.log("\n[Example A]");
  check("M1 = $175 (70%)", approx(proj.months[0].total, 175), proj.months[0].total);
  check("M2 = $150 (60%)", approx(proj.months[1].total, 150), proj.months[1].total);
  check("M6 = $50 (20%)", approx(proj.months[5].total, 50), proj.months[5].total);
  check("M7 = $10 (4% forever)", approx(proj.months[6].total, 10), proj.months[6].total);
  check("M60 still $10 (forever)", approx(proj.months[59].total, 10), proj.months[59].total);
  check("next start month suggestion = 8", suggestNextStartMonth(p.rules) === 8, suggestNextStartMonth(p.rules));
}

// --- Example B: 15% for 12 months then stop ---
{
  const p = plan([residual(1, 12, 15)]);
  const proj = projectPlanForClient(p, { setupFee: 0, monthlySubscription: 250 });
  console.log("\n[Example B]");
  check("M1 = $37.50", approx(proj.months[0].total, 37.5), proj.months[0].total);
  check("M12 = $37.50", approx(proj.months[11].total, 37.5), proj.months[11].total);
  check("M13 = $0 (stopped)", approx(proj.months[12].total, 0), proj.months[12].total);
  check("first 12 months total = $450", approx(proj.total12, 450), proj.total12);
}

// --- Example C: 20% yr1, 10% yr2, stop ---
{
  const p = plan([residual(1, 12, 20), residual(13, 24, 10)]);
  const proj = projectPlanForClient(p, { setupFee: 0, monthlySubscription: 250 });
  console.log("\n[Example C]");
  check("M12 = $50 (20%)", approx(proj.months[11].total, 50), proj.months[11].total);
  check("M13 = $25 (10%)", approx(proj.months[12].total, 25), proj.months[12].total);
  check("M25 = $0 (stopped)", approx(proj.months[24].total, 0), proj.months[24].total);
  check("24-month total = $900", approx(proj.total24, 900), proj.total24);
}

// --- Example D: $300/mo flat for 3 months, then 5% forever ---
{
  const p = plan([
    residual(1, 3, 300, "fixed"),
    residual(4, null, 5, "percentage", true),
  ]);
  const proj = projectPlanForClient(p, { setupFee: 0, monthlySubscription: 250 });
  console.log("\n[Example D]");
  check("M1 = $300 flat", approx(proj.months[0].total, 300), proj.months[0].total);
  check("M3 = $300 flat", approx(proj.months[2].total, 300), proj.months[2].total);
  check("M4 = $12.50 (5%)", approx(proj.months[3].total, 12.5), proj.months[3].total);
}

// --- Deterministic real payment calc ---
{
  const sp: Salesperson = {
    id: "sp1", name: "Test", email: "", phone: "", role: "salesperson",
    referralCode: "T", status: "active", commissionPlanId: "p1",
    weeklySalary: null, salaryStartDate: null, salaryEndDate: null, notes: "",
    source: "admin", approvalStatus: "approved", createdAt: "2025-01-01",
  };
  const client: Client = {
    id: "c1", companyName: "Acme", contactName: "", email: "", phone: "",
    salespersonId: "sp1", signupDate: "2025-01-01", setupFee: 2500,
    monthlySubscription: 250, status: "active", notes: "", createdAt: "2025-01-01",
  };
  const p = plan([
    { id: "s", type: "setup_fee", mode: "percentage", value: 50 },
    { id: "b", type: "signup_bonus", amount: 750 },
    residual(1, 1, 60),
    residual(2, null, 10, "percentage", true),
  ]);

  const setupPay: Payment = {
    id: "pay1", clientId: "c1", date: "2025-01-01", type: "setup_fee",
    amount: 2500, paymentNumber: null, notes: "", createdAt: "2025-01-01",
  };
  const setupRows = calculateCommissionForPayment(setupPay, client, sp, p);
  console.log("\n[Real payment calc]");
  check("setup payment -> 2 rows (setup + bonus)", setupRows.length === 2, setupRows.length);
  check("setup commission = $1,250", approx(setupRows.find(r => r.ruleType === "setup_fee")!.commissionAmount, 1250));
  check("signup bonus = $750", approx(setupRows.find(r => r.ruleType === "signup_bonus")!.commissionAmount, 750));

  const subPay: Payment = {
    id: "pay2", clientId: "c1", date: "2025-02-01", type: "monthly_subscription",
    amount: 250, paymentNumber: 5, notes: "", createdAt: "2025-02-01",
  };
  const subRows = calculateCommissionForPayment(subPay, client, sp, p);
  check("month-5 subscription -> 1 row at 10%", subRows.length === 1 && approx(subRows[0].commissionAmount, 25), subRows);
}

// --- Book projection sanity: 5 closings/mo @ $250, no churn ---
{
  const p = plan([residual(1, null, 10, "percentage", true)]);
  const book = projectBook(p, {
    avgSetupFee: 0, avgMonthly: 250, closingsPerMonth: 5,
    monthlyChurnPct: 0, months: 12,
  });
  console.log("\n[Book projection]");
  // Month 1: 5 active * 10% * $250 = $125
  check("M1 residual = $125 (5 clients)", approx(book.months[0].residualCommission, 125), book.months[0].residualCommission);
  // Month 12: 60 active * 10% * $250 = $1,500
  check("M12 residual = $1,500 (60 clients)", approx(book.months[11].residualCommission, 1500), book.months[11].residualCommission);
  check("M12 active clients = 60", approx(book.months[11].activeClients, 60), book.months[11].activeClients);
}

// --- Book projection with churn reduces active clients ---
{
  const p = plan([residual(1, null, 10, "percentage", true)]);
  const book = projectBook(p, {
    avgSetupFee: 0, avgMonthly: 250, closingsPerMonth: 10,
    monthlyChurnPct: 10, months: 12,
  });
  console.log("\n[Book projection w/ churn]");
  check("churn lowers M12 active below 120", book.months[11].activeClients < 120, book.months[11].activeClients);
  check("M12 active clients > 0", book.months[11].activeClients > 0, book.months[11].activeClients);
}

console.log(`\n========================\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
