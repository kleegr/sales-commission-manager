// ============================================================================
// COMMISSION ENGINE
//
// This module is the heart of the app. Every commission number shown anywhere
// in the UI comes from these pure, deterministic functions. There is NO AI and
// NO randomness here — given the same plan + inputs you always get the same
// result, which is exactly what a commission system needs.
//
// Two contexts use this engine:
//   1) PLAN PREVIEW / PROJECTION  -> projectPlanForClient() and projectBook()
//      Hypothetical "what would this plan pay" math, month-relative.
//   2) REAL LEDGER                -> calculateCommissionForPayment() and
//      generateSalaryEntries(), which turn real Payments + salaries into
//      concrete CommissionEntry rows.
//
// Salary note: the per-salesperson weekly salary (Salesperson.weeklySalary /
// salaryStartDate / salaryEndDate) is the source of truth for the REAL ledger.
// A `salary` RULE inside a plan is only used for plan PREVIEW projections, so
// the two never double-count.
// ============================================================================

import {
  type CommissionEntry,
  type CommissionPlan,
  type Client,
  type MonthlyResidualRule,
  type Payment,
  type ProjectionAssumptions,
  type Rule,
  type Salesperson,
  type SalaryRule,
  type SetupFeeRule,
  type SignupBonusRule,
  type ValueType,
} from "../types";
import {
  clampNum,
  formatCurrency,
  isoToDate,
  round2,
  uid,
  weeksBetween,
} from "./format";

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export interface CommissionLine {
  ruleId: string | null;
  ruleType: Rule["type"];
  ruleLabel: string;
  valueType: ValueType;
  value: number; // 70 (means 70%) or 150 (means $150)
  baseAmount: number; // the subscription / setup amount the calc applies to
  amount: number; // resolved dollars
}

export interface MonthBreakdown {
  month: number; // 1-based
  lines: CommissionLine[];
  total: number;
}

export interface PlanProjection {
  months: MonthBreakdown[];
  setupFeeLine: CommissionLine | null;
  signupBonusLine: CommissionLine | null;
  setupFeeCommission: number;
  signupBonus: number;
  yearTotals: number[]; // one per year (up to 5)
  total12: number;
  total24: number;
  total60: number;
  grandTotal: number; // every month in horizon (setup + bonus included as month-1 lines)
  horizon: number;
}

// ---------------------------------------------------------------------------
// Atomic rule math
// ---------------------------------------------------------------------------

export function setupFeeAmount(rule: SetupFeeRule, setupFee: number): number {
  if (rule.mode === "percentage") return (setupFee * rule.value) / 100;
  if (rule.mode === "fixed") return rule.value;
  return 0;
}

export function residualAmount(
  rule: MonthlyResidualRule,
  monthlyAmount: number,
): number {
  return rule.valueType === "percentage"
    ? (monthlyAmount * rule.value) / 100
    : rule.value;
}

/** Does a monthly residual rule apply to a given 1-based month number? */
export function ruleAppliesToMonth(
  rule: MonthlyResidualRule,
  month: number,
): boolean {
  if (month < rule.startMonth) return false;
  if (rule.continueForever) return true;
  if (rule.endMonth == null) return true;
  return month <= rule.endMonth;
}

// ---------------------------------------------------------------------------
// Labels (human-readable rule descriptions used in tables + ledger)
// ---------------------------------------------------------------------------

export function setupFeeLabel(rule: SetupFeeRule): string {
  if (rule.mode === "percentage") return `Setup fee · ${rule.value}%`;
  if (rule.mode === "fixed") return `Setup fee · ${formatCurrency(rule.value)} flat`;
  return "Setup fee · none";
}

export function residualLabel(rule: MonthlyResidualRule): string {
  const range = rule.continueForever
    ? `Month ${rule.startMonth}+ (forever)`
    : rule.startMonth === rule.endMonth
      ? `Month ${rule.startMonth}`
      : `Month ${rule.startMonth}–${rule.endMonth ?? "?"}`;
  const val =
    rule.valueType === "percentage"
      ? `${rule.value}%`
      : `${formatCurrency(rule.value)}/mo`;
  return `Residual · ${range} · ${val}`;
}

export function ruleHeadline(rule: Rule): string {
  switch (rule.type) {
    case "setup_fee":
      return setupFeeLabel(rule);
    case "signup_bonus":
      return `Signup bonus · ${formatCurrency(rule.amount)}`;
    case "monthly_residual":
      return residualLabel(rule);
    case "salary": {
      const bound = rule.maxWeeks
        ? ` · max ${rule.maxWeeks} wk`
        : rule.endDate
          ? ` · until ${rule.endDate}`
          : " · ongoing";
      return `Salary · ${formatCurrency(rule.weeklyAmount)}/wk${bound}`;
    }
  }
}

/** Suggest the next residual start month: max(existing end) + 1, else 1. */
export function suggestNextStartMonth(rules: Rule[]): number {
  const residuals = rules.filter(
    (r): r is MonthlyResidualRule => r.type === "monthly_residual",
  );
  let maxEnd = 0;
  for (const r of residuals) {
    if (r.continueForever) maxEnd = Math.max(maxEnd, r.startMonth);
    else if (r.endMonth != null) maxEnd = Math.max(maxEnd, r.endMonth);
    else maxEnd = Math.max(maxEnd, r.startMonth);
  }
  return maxEnd > 0 ? maxEnd + 1 : 1;
}

// ---------------------------------------------------------------------------
// Salary schedule (used for PLAN PREVIEW only)
// ---------------------------------------------------------------------------

/** Monthly salary contribution per month for a salary rule, across `horizon`. */
export function salaryScheduleByMonth(
  rule: SalaryRule,
  horizon: number,
): number[] {
  const arr = new Array(horizon).fill(0);
  const monthly = (rule.weeklyAmount || 0) * (52 / 12);
  if (monthly <= 0) return arr;

  let cap = Infinity;
  if (rule.maxWeeks != null && rule.maxWeeks > 0) {
    cap = rule.weeklyAmount * rule.maxWeeks;
  }
  if (rule.startDate && rule.endDate) {
    const w = weeksBetween(rule.startDate, rule.endDate);
    if (w > 0) cap = Math.min(cap, rule.weeklyAmount * w);
  }

  let paid = 0;
  for (let m = 0; m < horizon; m++) {
    if (paid >= cap - 1e-9) break;
    const pay = Math.min(monthly, cap - paid);
    arr[m] = round2(pay);
    paid += pay;
  }
  return arr;
}

// ---------------------------------------------------------------------------
// PLAN PREVIEW: single-client month-by-month projection
// ---------------------------------------------------------------------------

export function projectPlanForClient(
  plan: CommissionPlan,
  inputs: { setupFee: number; monthlySubscription: number; horizon?: number },
): PlanProjection {
  const horizon = clampNum(Math.round(inputs.horizon ?? 60), 1, 60);

  const setupRule = plan.rules.find(
    (r): r is SetupFeeRule => r.type === "setup_fee" && r.mode !== "none",
  );
  const bonusRule = plan.rules.find(
    (r): r is SignupBonusRule => r.type === "signup_bonus" && r.amount > 0,
  );
  const residuals = plan.rules.filter(
    (r): r is MonthlyResidualRule => r.type === "monthly_residual",
  );
  const salaries = plan.rules.filter(
    (r): r is SalaryRule => r.type === "salary",
  );

  const salaryByMonth = new Array(horizon).fill(0);
  for (const s of salaries) {
    const sched = salaryScheduleByMonth(s, horizon);
    for (let i = 0; i < horizon; i++) salaryByMonth[i] += sched[i];
  }

  let setupFeeLine: CommissionLine | null = null;
  let signupBonusLine: CommissionLine | null = null;
  const months: MonthBreakdown[] = [];

  for (let m = 1; m <= horizon; m++) {
    const lines: CommissionLine[] = [];

    if (m === 1 && setupRule) {
      const amount = round2(setupFeeAmount(setupRule, inputs.setupFee));
      setupFeeLine = {
        ruleId: setupRule.id,
        ruleType: "setup_fee",
        ruleLabel: setupFeeLabel(setupRule),
        valueType: setupRule.mode === "percentage" ? "percentage" : "fixed",
        value: setupRule.value,
        baseAmount: inputs.setupFee,
        amount,
      };
      if (amount !== 0) lines.push(setupFeeLine);
    }

    if (m === 1 && bonusRule) {
      signupBonusLine = {
        ruleId: bonusRule.id,
        ruleType: "signup_bonus",
        ruleLabel: "Signup bonus",
        valueType: "fixed",
        value: bonusRule.amount,
        baseAmount: 0,
        amount: round2(bonusRule.amount),
      };
      lines.push(signupBonusLine);
    }

    for (const r of residuals) {
      if (ruleAppliesToMonth(r, m)) {
        lines.push({
          ruleId: r.id,
          ruleType: "monthly_residual",
          ruleLabel: residualLabel(r),
          valueType: r.valueType,
          value: r.value,
          baseAmount: inputs.monthlySubscription,
          amount: round2(residualAmount(r, inputs.monthlySubscription)),
        });
      }
    }

    if (salaryByMonth[m - 1] > 0) {
      lines.push({
        ruleId: null,
        ruleType: "salary",
        ruleLabel: "Salary",
        valueType: "fixed",
        value: salaryByMonth[m - 1],
        baseAmount: 0,
        amount: salaryByMonth[m - 1],
      });
    }

    const total = round2(lines.reduce((s, l) => s + l.amount, 0));
    months.push({ month: m, lines, total });
  }

  const yearTotals: number[] = [];
  for (let y = 0; y < Math.ceil(horizon / 12); y++) {
    let t = 0;
    for (let m = y * 12; m < Math.min((y + 1) * 12, horizon); m++)
      t += months[m].total;
    yearTotals.push(round2(t));
  }
  const cum = (n: number) =>
    round2(
      months.slice(0, Math.min(n, horizon)).reduce((s, mm) => s + mm.total, 0),
    );

  return {
    months,
    setupFeeLine,
    signupBonusLine,
    setupFeeCommission: setupFeeLine?.amount ?? 0,
    signupBonus: signupBonusLine?.amount ?? 0,
    yearTotals,
    total12: cum(12),
    total24: cum(24),
    total60: cum(60),
    grandTotal: round2(months.reduce((s, mm) => s + mm.total, 0)),
    horizon,
  };
}

// ---------------------------------------------------------------------------
// REAL LEDGER: deterministic commission from a single Payment
// ---------------------------------------------------------------------------

/**
 * The function the spec asks for: accepts a Payment + Client + Salesperson +
 * CommissionPlan and returns the resulting commission rows. Pure + testable.
 */
export function calculateCommissionForPayment(
  payment: Payment,
  client: Client,
  salesperson: Salesperson,
  plan: CommissionPlan,
): CommissionEntry[] {
  const entries: CommissionEntry[] = [];

  const make = (
    partial: Partial<CommissionEntry> &
      Pick<
        CommissionEntry,
        | "ruleId"
        | "ruleType"
        | "ruleLabel"
        | "commissionValueType"
        | "commissionValue"
        | "commissionAmount"
      >,
  ): CommissionEntry => ({
    id: uid("cm"),
    salespersonId: salesperson.id,
    clientId: client.id,
    paymentId: payment.id,
    paymentDate: payment.date,
    paymentType: payment.type,
    paymentAmount: payment.amount,
    status: "pending",
    dueDate: payment.date,
    paidDate: null,
    notes: "",
    isProjection: false,
    createdAt: new Date().toISOString(),
    ...partial,
  });

  if (payment.type === "setup_fee") {
    const setupRule = plan.rules.find(
      (r): r is SetupFeeRule => r.type === "setup_fee" && r.mode !== "none",
    );
    if (setupRule) {
      const amount = round2(setupFeeAmount(setupRule, payment.amount));
      if (amount !== 0) {
        entries.push(
          make({
            ruleId: setupRule.id,
            ruleType: "setup_fee",
            ruleLabel: setupFeeLabel(setupRule),
            commissionValueType:
              setupRule.mode === "percentage" ? "percentage" : "fixed",
            commissionValue: setupRule.value,
            commissionAmount: amount,
          }),
        );
      }
    }
    // Signup bonus is paid once, triggered by the setup-fee payment.
    const bonusRule = plan.rules.find(
      (r): r is SignupBonusRule => r.type === "signup_bonus" && r.amount > 0,
    );
    if (bonusRule) {
      entries.push(
        make({
          ruleId: bonusRule.id,
          ruleType: "signup_bonus",
          ruleLabel: "Signup bonus",
          commissionValueType: "fixed",
          commissionValue: bonusRule.amount,
          commissionAmount: round2(bonusRule.amount),
        }),
      );
    }
  } else if (payment.type === "monthly_subscription") {
    const monthNum = payment.paymentNumber ?? 1;
    const residuals = plan.rules.filter(
      (r): r is MonthlyResidualRule => r.type === "monthly_residual",
    );
    for (const r of residuals) {
      if (ruleAppliesToMonth(r, monthNum)) {
        entries.push(
          make({
            ruleId: r.id,
            ruleType: "monthly_residual",
            ruleLabel: residualLabel(r),
            commissionValueType: r.valueType,
            commissionValue: r.value,
            commissionAmount: round2(residualAmount(r, payment.amount)),
          }),
        );
      }
    }
  }
  // refund / adjustment payments do not auto-generate commissions here.
  return entries;
}

/** Weekly salary ledger entries from a salesperson's own salary settings. */
export function generateSalaryEntries(
  sp: Salesperson,
  toISO: string,
): CommissionEntry[] {
  const out: CommissionEntry[] = [];
  if (!sp.weeklySalary || sp.weeklySalary <= 0 || !sp.salaryStartDate)
    return out;

  const start = isoToDate(sp.salaryStartDate);
  const hardEnd = sp.salaryEndDate ? isoToDate(sp.salaryEndDate) : null;
  const to = isoToDate(toISO);
  const cursor = new Date(start);
  let guard = 0;

  while (cursor <= to && guard < 520) {
    if (hardEnd && cursor > hardEnd) break;
    const iso = cursor.toISOString().slice(0, 10);
    out.push({
      id: `sal_${sp.id}_${iso}`,
      salespersonId: sp.id,
      clientId: null,
      paymentId: null,
      paymentDate: iso,
      paymentType: "salary",
      paymentAmount: sp.weeklySalary,
      ruleId: null,
      ruleType: "salary",
      ruleLabel: "Weekly salary",
      commissionValueType: "fixed",
      commissionValue: sp.weeklySalary,
      commissionAmount: round2(sp.weeklySalary),
      status: "pending",
      dueDate: iso,
      paidDate: null,
      notes: "",
      isProjection: false,
      createdAt: new Date().toISOString(),
    });
    cursor.setDate(cursor.getDate() + 7);
    guard++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// BOOK PROJECTION: multi-closing-per-month, churn-adjusted (section 4)
// ---------------------------------------------------------------------------

export interface BookMonth {
  month: number;
  newClients: number;
  activeClients: number;
  setupCommission: number;
  signupBonus: number;
  residualCommission: number;
  salary: number;
  total: number;
  cumulative: number;
}

export interface BookProjection {
  months: BookMonth[];
  yearTotals: number[];
  total12: number;
  total24: number;
  total60: number;
  grandTotal: number;
}

/**
 * Models a salesperson's growing book of business:
 *  - `closingsPerMonth` new clients sign up every month (a cohort)
 *  - each cohort earns residuals based on its own age (months since signup)
 *  - churn shrinks each cohort by `monthlyChurnPct` every month
 * The result is the realistic "commissions compound as the book grows" curve.
 */
export function projectBook(
  plan: CommissionPlan,
  a: ProjectionAssumptions,
): BookProjection {
  const horizon = clampNum(Math.round(a.months ?? 60), 1, 60);
  const churn = clampNum(a.monthlyChurnPct ?? 0, 0, 100) / 100;

  const setupRule = plan.rules.find(
    (r): r is SetupFeeRule => r.type === "setup_fee" && r.mode !== "none",
  );
  const bonusRule = plan.rules.find(
    (r): r is SignupBonusRule => r.type === "signup_bonus" && r.amount > 0,
  );
  const residuals = plan.rules.filter(
    (r): r is MonthlyResidualRule => r.type === "monthly_residual",
  );
  const salaries = plan.rules.filter(
    (r): r is SalaryRule => r.type === "salary",
  );

  const setupPer = setupRule ? setupFeeAmount(setupRule, a.avgSetupFee) : 0;
  const bonusPer = bonusRule ? bonusRule.amount : 0;
  const residualForAge = (age: number) =>
    residuals.reduce(
      (s, r) => s + (ruleAppliesToMonth(r, age) ? residualAmount(r, a.avgMonthly) : 0),
      0,
    );

  const salaryByMonth = new Array(horizon).fill(0);
  for (const s of salaries) {
    const sched = salaryScheduleByMonth(s, horizon);
    for (let i = 0; i < horizon; i++) salaryByMonth[i] += sched[i];
  }

  const months: BookMonth[] = [];
  let cumulative = 0;
  for (let T = 1; T <= horizon; T++) {
    const newClients = a.closingsPerMonth;
    let activeClients = 0;
    let residualCommission = 0;
    for (let c = 1; c <= T; c++) {
      const age = T - c + 1; // 1 in the month they sign up
      const active = a.closingsPerMonth * Math.pow(1 - churn, age - 1);
      activeClients += active;
      residualCommission += active * residualForAge(age);
    }
    const setupCommission = newClients * setupPer;
    const signupBonus = newClients * bonusPer;
    const salary = salaryByMonth[T - 1];
    const total = setupCommission + signupBonus + residualCommission + salary;
    cumulative += total;
    months.push({
      month: T,
      newClients,
      activeClients: round2(activeClients),
      setupCommission: round2(setupCommission),
      signupBonus: round2(signupBonus),
      residualCommission: round2(residualCommission),
      salary: round2(salary),
      total: round2(total),
      cumulative: round2(cumulative),
    });
  }

  const yearTotals: number[] = [];
  for (let y = 0; y < Math.ceil(horizon / 12); y++) {
    let t = 0;
    for (let m = y * 12; m < Math.min((y + 1) * 12, horizon); m++)
      t += months[m].total;
    yearTotals.push(round2(t));
  }
  const cum = (n: number) =>
    round2(
      months.slice(0, Math.min(n, horizon)).reduce((s, mm) => s + mm.total, 0),
    );

  return {
    months,
    yearTotals,
    total12: cum(12),
    total24: cum(24),
    total60: cum(60),
    grandTotal: round2(cumulative),
  };
}
