// ============================================================================
// DEMO DATA
//
// Preloads the prototype with realistic, interconnected data so every screen
// has something to show. Payments are run through the real commission engine,
// so the ledger you see is genuinely computed — not hand-written.
// ============================================================================

import {
  recomputePaymentCommissions,
  recomputeSalaryEntries,
} from "./ledger.js";
import {
  addMonthsISO,
  monthsSince,
  todayISO,
  uid,
} from "./format.js";
import {
  SCHEMA_VERSION,
  type AppData,
  type Client,
  type CommissionPlan,
  type Payment,
  type Salesperson,
} from "../types/index.js";

function makePlans(): CommissionPlan[] {
  return [
    {
      id: "plan_standard",
      name: "Standard SaaS Plan",
      description:
        "Big upfront residual that steps down over 6 months, then a small lifetime residual. Classic new-logo plan.",
      sampleSetupFee: 2500,
      sampleMonthly: 250,
      createdAt: "2025-07-01",
      // Showcase timing: every commission is held through a 14-day refund
      // window, only pays while the client is active, and is clawed back if the
      // client cancels inside the first 3 months.
      timing: {
        trigger: "after_refund_window",
        days: 14,
        months: 0,
        payments: 0,
        requireActiveClient: true,
        clawbackBeforeMonths: 3,
      },
      rules: [
        { id: uid("r"), type: "setup_fee", mode: "percentage", value: 50 },
        { id: uid("r"), type: "monthly_residual", startMonth: 1, endMonth: 1, continueForever: false, valueType: "percentage", value: 70 },
        { id: uid("r"), type: "monthly_residual", startMonth: 2, endMonth: 2, continueForever: false, valueType: "percentage", value: 60 },
        { id: uid("r"), type: "monthly_residual", startMonth: 3, endMonth: 3, continueForever: false, valueType: "percentage", value: 50 },
        { id: uid("r"), type: "monthly_residual", startMonth: 4, endMonth: 4, continueForever: false, valueType: "percentage", value: 40 },
        { id: uid("r"), type: "monthly_residual", startMonth: 5, endMonth: 5, continueForever: false, valueType: "percentage", value: 30 },
        { id: uid("r"), type: "monthly_residual", startMonth: 6, endMonth: 6, continueForever: false, valueType: "percentage", value: 20 },
        { id: uid("r"), type: "monthly_residual", startMonth: 7, endMonth: null, continueForever: true, valueType: "percentage", value: 4 },
      ],
    },
    {
      id: "plan_affiliate12",
      name: "Affiliate · 12-Month Residual",
      description: "Flat 15% of monthly subscription for the first year, then nothing. Simple affiliate deal.",
      sampleSetupFee: 1500,
      sampleMonthly: 200,
      createdAt: "2025-07-02",
      // Showcase timing: commissions are held until an admin approves/releases
      // them (the manual gate). Demonstrates the "Release now" workflow.
      timing: {
        trigger: "on_approval",
        days: 0,
        months: 0,
        payments: 0,
        requireActiveClient: false,
        clawbackBeforeMonths: 0,
      },
      rules: [
        { id: uid("r"), type: "monthly_residual", startMonth: 1, endMonth: 12, continueForever: false, valueType: "percentage", value: 15 },
      ],
    },
    {
      id: "plan_partner24",
      name: "Partner · 2-Year Tiered + Bonus",
      description: "$750 signup bonus, 20% of monthly for year one, 10% for year two, then stops.",
      sampleSetupFee: 3000,
      sampleMonthly: 300,
      createdAt: "2025-07-03",
      rules: [
        { id: uid("r"), type: "signup_bonus", amount: 750 },
        { id: uid("r"), type: "monthly_residual", startMonth: 1, endMonth: 12, continueForever: false, valueType: "percentage", value: 20 },
        { id: uid("r"), type: "monthly_residual", startMonth: 13, endMonth: 24, continueForever: false, valueType: "percentage", value: 10 },
      ],
    },
    {
      id: "plan_hybrid",
      name: "Hybrid · Flat then Residual",
      description: "$500 flat from setup, $300/mo guaranteed for 3 months, then 5% of monthly forever.",
      sampleSetupFee: 2000,
      sampleMonthly: 250,
      createdAt: "2025-07-04",
      rules: [
        { id: uid("r"), type: "setup_fee", mode: "fixed", value: 500 },
        { id: uid("r"), type: "monthly_residual", startMonth: 1, endMonth: 3, continueForever: false, valueType: "fixed", value: 300 },
        { id: uid("r"), type: "monthly_residual", startMonth: 4, endMonth: null, continueForever: true, valueType: "percentage", value: 5 },
      ],
    },
    {
      id: "plan_salaried",
      name: "Salaried Rep · Base + Commission",
      description: "$600/week base salary plus 30% of setup and a 10% lifetime residual. For employed reps.",
      sampleSetupFee: 2500,
      sampleMonthly: 250,
      createdAt: "2025-07-05",
      rules: [
        { id: uid("r"), type: "salary", weeklyAmount: 600, startDate: null, endDate: null, maxWeeks: null },
        { id: uid("r"), type: "setup_fee", mode: "percentage", value: 30 },
        { id: uid("r"), type: "monthly_residual", startMonth: 1, endMonth: null, continueForever: true, valueType: "percentage", value: 10 },
      ],
    },
  ];
}

function makeSalespeople(): Salesperson[] {
  return [
    {
      id: "sp_jordan",
      name: "Jordan Avery",
      email: "jordan@example.com",
      phone: "(555) 201-3344",
      role: "salesperson",
      referralCode: "JORDAN10",
      status: "active",
      commissionPlanId: "plan_standard",
      weeklySalary: null,
      salaryStartDate: null,
      salaryEndDate: null,
      notes: "Top closer. Handles inbound demos.",
      source: "admin",
      approvalStatus: "approved",
      createdAt: "2025-07-10",
    },
    {
      id: "sp_riley",
      name: "Riley Chen",
      email: "riley@partnerblog.com",
      phone: "(555) 778-9090",
      role: "affiliate",
      referralCode: "RILEYAFF",
      status: "active",
      commissionPlanId: "plan_affiliate12",
      weeklySalary: null,
      salaryStartDate: null,
      salaryEndDate: null,
      notes: "Content affiliate, drives blog signups.",
      source: "admin",
      approvalStatus: "approved",
      createdAt: "2025-08-01",
    },
    {
      id: "sp_morgan",
      name: "Morgan Diaz",
      email: "morgan@example.com",
      phone: "(555) 440-1212",
      role: "partner",
      referralCode: "MORGANP",
      status: "active",
      commissionPlanId: "plan_salaried",
      weeklySalary: 600,
      salaryStartDate: "2026-04-01",
      salaryEndDate: null,
      notes: "Salaried partner manager. Base + commission.",
      source: "admin",
      approvalStatus: "approved",
      createdAt: "2026-03-20",
    },
    {
      // Pending affiliate from the public signup portal (awaiting approval).
      id: "sp_taylor",
      name: "Taylor Brooks",
      email: "taylor@growthco.io",
      phone: "(555) 656-1001",
      role: "affiliate",
      referralCode: "TAYLOR",
      status: "inactive",
      commissionPlanId: null,
      weeklySalary: null,
      salaryStartDate: null,
      salaryEndDate: null,
      notes: "Applied via affiliate portal. Runs a SaaS newsletter (12k subs).",
      source: "affiliate_portal",
      approvalStatus: "pending",
      companyName: "GrowthCo",
      website: "https://growthco.io",
      referralSource: "Twitter / X",
      createdAt: addMonthsISO(todayISO(), 0),
    },
  ];
}

interface ClientSeed extends Omit<Client, "createdAt"> {
  paidMonths: number; // how many monthly payments to record
}

function makeClients(): ClientSeed[] {
  return [
    { id: "cl_acme", companyName: "Acme Corp", contactName: "Wile E.", email: "ops@acme.test", phone: "(555) 111-0001", salespersonId: "sp_jordan", signupDate: "2025-09-05", setupFee: 2500, monthlySubscription: 250, status: "active", canceledDate: null, notes: "", paidMonths: 99 },
    { id: "cl_globex", companyName: "Globex", contactName: "Hank S.", email: "it@globex.test", phone: "(555) 111-0002", salespersonId: "sp_jordan", signupDate: "2025-11-12", setupFee: 2500, monthlySubscription: 300, status: "active", canceledDate: null, notes: "", paidMonths: 99 },
    { id: "cl_initech", companyName: "Initech", contactName: "Peter G.", email: "tps@initech.test", phone: "(555) 111-0003", salespersonId: "sp_jordan", signupDate: "2026-02-20", setupFee: 2000, monthlySubscription: 250, status: "active", canceledDate: null, notes: "", paidMonths: 99 },
    { id: "cl_umbrella", companyName: "Umbrella LLC", contactName: "Alice M.", email: "admin@umbrella.test", phone: "(555) 111-0004", salespersonId: "sp_riley", signupDate: "2025-10-01", setupFee: 1500, monthlySubscription: 200, status: "active", canceledDate: null, notes: "", paidMonths: 99 },
    { id: "cl_soylent", companyName: "Soylent Foods", contactName: "Joe C.", email: "hello@soylent.test", phone: "(555) 111-0005", salespersonId: "sp_riley", signupDate: "2026-01-15", setupFee: 1500, monthlySubscription: 200, status: "active", canceledDate: null, notes: "", paidMonths: 99 },
    { id: "cl_stark", companyName: "Stark Industries", contactName: "Pepper P.", email: "billing@stark.test", phone: "(555) 111-0006", salespersonId: "sp_morgan", signupDate: "2026-04-10", setupFee: 3000, monthlySubscription: 350, status: "active", canceledDate: null, notes: "", paidMonths: 99 },
    { id: "cl_wayne", companyName: "Wayne Enterprises", contactName: "Lucius F.", email: "ap@wayne.test", phone: "(555) 111-0007", salespersonId: "sp_morgan", signupDate: "2025-12-01", setupFee: 3000, monthlySubscription: 300, status: "canceled", canceledDate: "2026-03-01", notes: "Churned after 3 months.", paidMonths: 3 },
    { id: "cl_hooli", companyName: "Hooli", contactName: "Gavin B.", email: "ops@hooli.test", phone: "(555) 111-0008", salespersonId: "sp_jordan", signupDate: "2026-03-01", setupFee: 2200, monthlySubscription: 275, status: "paused", canceledDate: null, notes: "Paused billing while migrating.", paidMonths: 2 },
    { id: "cl_vandelay", companyName: "Vandelay Industries", contactName: "Art V.", email: "art@vandelay.test", phone: "(555) 111-0009", salespersonId: "sp_jordan", signupDate: "2026-04-15", setupFee: 2500, monthlySubscription: 250, status: "canceled", canceledDate: "2026-05-20", notes: "Canceled inside the first 3 months — commission clawed back.", paidMonths: 1 },
  ];
}

function makePayments(clients: ClientSeed[]): Payment[] {
  const today = todayISO();
  const payments: Payment[] = [];
  for (const c of clients) {
    // Setup fee paid at signup
    payments.push({
      id: uid("pay"),
      clientId: c.id,
      date: c.signupDate,
      type: "setup_fee",
      amount: c.setupFee,
      paymentNumber: null,
      notes: "Initial setup fee",
      createdAt: c.signupDate,
    });
    // Monthly subscription payments
    const elapsed = Math.max(0, monthsSince(c.signupDate));
    const months = Math.min(elapsed, c.paidMonths);
    for (let n = 1; n <= months; n++) {
      const date = addMonthsISO(c.signupDate, n);
      if (date > today) break;
      payments.push({
        id: uid("pay"),
        clientId: c.id,
        date,
        type: "monthly_subscription",
        amount: c.monthlySubscription,
        paymentNumber: n,
        notes: "",
        createdAt: date,
      });
    }
  }
  return payments;
}

export function buildDemoData(): AppData {
  const plans = makePlans();
  const salespeople = makeSalespeople();
  const clientSeeds = makeClients();
  const clients: Client[] = clientSeeds.map(({ paidMonths, ...c }) => ({
    ...c,
    createdAt: c.signupDate,
  }));
  const payments = makePayments(clientSeeds);

  const base: AppData = {
    salespeople,
    plans,
    clients,
    payments,
    commissions: [],
    payouts: [],
    version: SCHEMA_VERSION,
    settings: {
      theme: "light",
      companyName: "Your Company",
      assumptions: {
        avgSetupFee: 2500,
        avgMonthly: 250,
        closingsPerMonth: 5,
        monthlyChurnPct: 3,
        months: 60,
      },
    },
  };

  // Run payments + salaries through the engine to populate the ledger.
  base.commissions = recomputePaymentCommissions(base);
  base.commissions = recomputeSalaryEntries(base);

  // Age the statuses so there's a realistic mix of paid / approved / pending —
  // but ONLY for commissions the timing engine has released (status "pending").
  // Lines that timing is holding ("held") or has reversed ("clawed_back") keep
  // their timing-derived status so the hold / release / clawback feature is
  // visible in the demo ledger.
  for (const e of base.commissions) {
    if (e.status !== "pending") continue; // leave held / clawed_back untouched
    const age = monthsSince(e.dueDate);
    if (age >= 3) {
      e.status = "paid";
      e.paidDate = addMonthsISO(e.dueDate, 0);
    } else if (age === 2) {
      e.status = "approved";
    } else if (age === 1) {
      e.status = "submitted";
    } else {
      e.status = "pending";
    }
  }

  // Build one historical payout (paid) for Jordan from his paid commissions.
  const jordanPaid = base.commissions.filter(
    (e) => e.salespersonId === "sp_jordan" && e.status === "paid",
  );
  if (jordanPaid.length > 0) {
    const subset = jordanPaid.slice(0, Math.min(6, jordanPaid.length));
    base.payouts.push({
      id: uid("po"),
      salespersonId: "sp_jordan",
      commissionEntryIds: subset.map((e) => e.id),
      totalAmount:
        Math.round(subset.reduce((s, e) => s + e.commissionAmount, 0) * 100) /
        100,
      status: "paid",
      notes: "Q1 payout batch",
      createdAt: addMonthsISO(todayISO(), -2),
      submittedAt: addMonthsISO(todayISO(), -2),
      approvedAt: addMonthsISO(todayISO(), -2),
      paidAt: addMonthsISO(todayISO(), -2),
    });
  }

  return base;
}
