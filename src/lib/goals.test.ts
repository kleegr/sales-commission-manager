// Dependency-free, DB-free tests for the goals progress + projection helpers.
// Run via `tsx src/lib/goals.test.ts` (wired into `npm test`).
import {
  monthRange,
  quarterRange,
  inDateRange,
  resolveGoalPeriod,
  metricActual,
  goalProgress,
  paceProjection,
  daysBetween,
  projectedCommissionPerDeal,
  milestoneViews,
  nextMilestone,
} from "./goals";
import type {
  AppData,
  Client,
  CommissionEntry,
  CommissionPlan,
  Goal,
  Milestone,
  Payment,
  Salesperson,
} from "../types";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    console.error(`  \u2717 ${name}`, extra ?? "");
  }
}

// --- fixtures ---------------------------------------------------------------

function sp(id: string, extra: Partial<Salesperson> = {}): Salesperson {
  return {
    id, name: id, email: "", phone: "", role: "salesperson", referralCode: "",
    status: "active", commissionPlanId: "plan1", weeklySalary: null,
    salaryStartDate: null, salaryEndDate: null, notes: "", source: "admin",
    approvalStatus: "approved", createdAt: "2025-01-01", ...extra,
  };
}
function client(id: string, spId: string | null, signup: string, monthly = 250, status: Client["status"] = "active"): Client {
  return {
    id, companyName: id, contactName: "", email: "", phone: "", salespersonId: spId,
    signupDate: signup, setupFee: 2500, monthlySubscription: monthly, status, notes: "", createdAt: signup,
  };
}
function pay(id: string, clientId: string, date: string, type: Payment["type"], amount: number): Payment {
  return { id, clientId, date, type, amount, paymentNumber: null, notes: "", createdAt: date };
}
function comm(id: string, spId: string, date: string, amount: number, status: CommissionEntry["status"], isProjection = false): CommissionEntry {
  return {
    id, salespersonId: spId, clientId: "c1", paymentId: "p1", paymentDate: date,
    paymentType: "monthly_subscription", paymentAmount: amount, ruleId: null, ruleType: "monthly_residual",
    ruleLabel: "", commissionValueType: "percentage", commissionValue: 10, commissionAmount: amount,
    status, dueDate: date, paidDate: null, notes: "", isProjection, createdAt: date,
  };
}

// Two reps; rep A signs 2 clients in Jan, rep B signs 1 in Feb.
const data: AppData = {
  salespeople: [sp("A"), sp("B")],
  plans: [
    {
      id: "plan1", name: "Std", description: "", createdAt: "2025-01-01",
      sampleSetupFee: 2500, sampleMonthly: 250,
      rules: [
        { id: "r1", type: "setup_fee", mode: "percentage", value: 50 },
        { id: "r2", type: "monthly_residual", startMonth: 1, endMonth: null, continueForever: true, valueType: "percentage", value: 10 },
      ],
    } as CommissionPlan,
  ],
  clients: [
    client("c1", "A", "2025-01-10", 250, "active"),
    client("c2", "A", "2025-01-20", 400, "active"),
    client("c3", "B", "2025-02-05", 300, "canceled"),
  ],
  payments: [
    pay("p1", "c1", "2025-01-10", "setup_fee", 2500),
    pay("p2", "c1", "2025-01-15", "monthly_subscription", 250),
    pay("p3", "c2", "2025-01-25", "setup_fee", 2500),
    pay("p4", "c1", "2025-02-15", "monthly_subscription", 250), // out of Jan
    pay("p5", "c1", "2025-01-28", "refund", 100), // reduces Jan revenue
  ],
  commissions: [
    comm("m1", "A", "2025-01-15", 300, "paid"),
    comm("m2", "A", "2025-01-25", 200, "pending"),
    comm("m3", "A", "2025-01-26", 999, "projected", true), // ignored (projection)
    comm("m4", "A", "2025-02-10", 500, "approved"), // out of Jan
  ],
  payouts: [],
  settings: { theme: "light", companyName: "", assumptions: { avgSetupFee: 2500, avgMonthly: 250, closingsPerMonth: 5, monthlyChurnPct: 3, months: 60 } },
  version: 1,
};

const A = new Set(["A"]);
const jan = { start: "2025-01-01", end: "2025-01-31" };

console.log("\n[Goals \u00b7 date helpers]");
ok("monthRange Jan", monthRange("2025-01-15").start === "2025-01-01" && monthRange("2025-01-15").end === "2025-01-31");
ok("monthRange Feb (28d)", monthRange("2025-02-10").end === "2025-02-28");
ok("monthRange leap Feb (29d)", monthRange("2024-02-10").end === "2024-02-29");
ok("quarterRange Q1", quarterRange("2025-02-15").start === "2025-01-01" && quarterRange("2025-02-15").end === "2025-03-31");
ok("quarterRange Q4", quarterRange("2025-11-01").start === "2025-10-01" && quarterRange("2025-11-01").end === "2025-12-31");
ok("inDateRange inside", inDateRange("2025-01-15", "2025-01-01", "2025-01-31"));
ok("inDateRange outside", !inDateRange("2025-02-01", "2025-01-01", "2025-01-31"));
ok("inDateRange open end", inDateRange("2030-01-01", "2025-01-01", null));
ok("daysBetween Jan span", daysBetween("2025-01-01", "2025-01-31") === 30);

console.log("\n[Goals \u00b7 resolveGoalPeriod]");
const gMonthly: Goal = { id: "g", scopeType: "salesperson", salespersonId: "A", managerUserId: null, metric: "revenue", title: "", targetValue: 5000, period: "monthly", periodStart: "2025-01-01", periodEnd: null, status: "active", createdAt: "" };
ok("monthly resolves to its month", resolveGoalPeriod(gMonthly, "2025-01-20").start === "2025-01-01" && resolveGoalPeriod(gMonthly, "2025-01-20").end === "2025-01-31");
const gCustom: Goal = { ...gMonthly, period: "custom", periodStart: "2025-01-05", periodEnd: "2025-03-09" };
ok("custom uses stored bounds", resolveGoalPeriod(gCustom, "2025-02-01").start === "2025-01-05" && resolveGoalPeriod(gCustom, "2025-02-01").end === "2025-03-09");

console.log("\n[Goals \u00b7 metricActual]");
// Jan revenue for A: 2500 + 250 + 2500 − 100 = 5150 (p4 is Feb, excluded)
ok("revenue (scoped + period)", metricActual("revenue", data, A, jan) === 5150, metricActual("revenue", data, A, jan));
ok("clients_closed Jan A = 2", metricActual("clients_closed", data, A, jan) === 2);
ok("referrals Jan A = 2", metricActual("referrals", data, A, jan) === 2);
ok("clients_closed Feb B = 1", metricActual("clients_closed", data, new Set(["B"]), monthRange("2025-02-01")) === 1);
// MRR = active clients' monthly for A: 250 + 400 = 650 (c3 is B + canceled)
ok("mrr active only", metricActual("mrr", data, A, jan) === 650);
ok("mrr tenant-wide (null scope) excludes canceled", metricActual("mrr", data, null, jan) === 650);
// commission_earned Jan A: 300 (paid) + 200 (pending) = 500; projection + Feb excluded
ok("commission_earned earned-in-period", metricActual("commission_earned", data, A, jan) === 500, metricActual("commission_earned", data, A, jan));
// activity Jan A: 2 clients + 4 Jan payments (p1,p2,p3,p5) = 6
ok("activity proxy", metricActual("activity", data, A, jan) === 6, metricActual("activity", data, A, jan));
ok("scope isolates B from A", metricActual("clients_closed", data, new Set(["B"]), jan) === 0);

console.log("\n[Goals \u00b7 progress + pace]");
const prog = goalProgress(5150, 5000);
ok("pct clamps to 100 when over", prog.pct === 100 && prog.reached);
ok("remaining floors at 0", prog.remaining === 0);
const prog2 = goalProgress(2500, 10000);
ok("pct partial", prog2.pct === 25 && !prog2.reached);
ok("remaining = target − actual", prog2.remaining === 7500);
ok("zero target -> 0%", goalProgress(0, 0).pct === 0);

// Halfway through a 30-day window with half the target -> on pace to hit it.
const pace = paceProjection(2500, 5000, { start: "2025-01-01", end: "2025-01-31" }, "2025-01-16");
ok("elapsedFraction ~0.5 mid-period", Math.abs(pace.elapsedFraction - 0.5) < 0.05, pace.elapsedFraction);
ok("projectedEnd ~ double actual", Math.abs(pace.projectedEnd - 5000) < 400, pace.projectedEnd);
const ahead = paceProjection(2700, 5000, { start: "2025-01-01", end: "2025-01-31" }, "2025-01-16");
ok("onTrack when projection meets target", ahead.onTrack, ahead.projectedEnd);
const behind = paceProjection(500, 5000, { start: "2025-01-01", end: "2025-01-31" }, "2025-01-16");
ok("not onTrack when behind pace", !behind.onTrack);
ok("open period returns actual as projection", paceProjection(300, 1000, { start: null, end: null }, "2025-01-16").projectedEnd === 300);

console.log("\n[Goals \u00b7 motivational projections]");
const perDeal = projectedCommissionPerDeal(data.plans[0], 2500, 250);
// setup 50% of 2500 = 1250, plus 12 months residual @10% of 250 = 12*25 = 300 -> 1550
ok("per-deal 12mo commission", Math.abs(perDeal - 1550) < 1, perDeal);
ok("3 more deals = 3x", Math.abs(perDeal * 3 - 4650) < 3);
ok("no plan -> 0", projectedCommissionPerDeal(null, 2500, 250) === 0);

console.log("\n[Goals \u00b7 milestones]");
const ms: Milestone[] = [
  { id: "x", goalId: "g", title: "Halfway", thresholdValue: 2500, reward: "", createdAt: "" },
  { id: "y", goalId: "g", title: "Bonus", thresholdValue: 5000, reward: "$500 bonus", createdAt: "" },
  { id: "z", goalId: "g", title: "Quarter", thresholdValue: 1250, reward: "", createdAt: "" },
];
const views = milestoneViews(ms, 2600);
ok("milestones sorted by threshold", views[0].thresholdValue === 1250 && views[2].thresholdValue === 5000);
ok("achieved flags by actual", views[0].achieved && views[1].achieved && !views[2].achieved);
const next = nextMilestone(ms, 2600);
ok("nextMilestone is first unmet", !!next && next.thresholdValue === 5000);
ok("next remaining correct", !!next && next.remaining === 2400);
ok("all reached -> null", nextMilestone(ms, 9999) === null);

console.log(`\n========================\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
