// Dependency-free, DB-free tests for the commission timing engine
// (hold / release / clawback) and its integration with the ledger recompute.
// Run via `tsx src/lib/commission-timing.test.ts` (wired into `npm test`).
import {
  DEFAULT_TIMING,
  normalizeTiming,
  resolveCommissionTiming,
  timingHeadline,
  effectiveDate,
  isHeld,
  type TimingContext,
} from "./commission-timing";
import {
  recomputePaymentCommissions,
  fullLedger,
} from "./ledger";
import type {
  AppData,
  Client,
  CommissionPlan,
  CommissionTiming,
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

// --- helpers ----------------------------------------------------------------

function timing(t: Partial<CommissionTiming>): CommissionTiming {
  return normalizeTiming(t);
}

function ctx(over: Partial<TimingContext> & { timing: CommissionTiming }): TimingContext {
  return {
    earnedDate: "2025-06-01",
    asOf: "2025-06-15",
    clientStatus: "active",
    clientSignupDate: "2025-01-01",
    clientCanceledDate: null,
    clientPaymentCount: 0,
    releasedOverride: false,
    ...over,
  };
}

// ============================================================================
console.log("\n[Timing \u00b7 normalize + headline]");
// ============================================================================

ok("undefined -> default (immediate)", normalizeTiming(undefined).trigger === "immediate");
ok("null -> default", normalizeTiming(null).trigger === "immediate");
ok("default is pay-immediately", DEFAULT_TIMING.trigger === "immediate");
ok(
  "negative numbers floored to 0",
  normalizeTiming({ trigger: "after_days", days: -5 }).days === 0,
);
ok(
  "fractional numbers floored",
  normalizeTiming({ trigger: "after_days", days: 30.9 }).days === 30,
);
ok(
  "invalid trigger coerced to immediate",
  normalizeTiming({ trigger: "nonsense" as never }).trigger === "immediate",
);
ok("headline immediate", timingHeadline({ ...DEFAULT_TIMING }) === "Pays immediately");
ok(
  "headline after_days pluralizes",
  timingHeadline(timing({ trigger: "after_days", days: 30 })) === "Pays 30 days after earned",
);
ok(
  "headline singular day",
  timingHeadline(timing({ trigger: "after_days", days: 1 })) === "Pays 1 day after earned",
);
ok(
  "headline appends extras",
  timingHeadline(
    timing({ trigger: "immediate", requireActiveClient: true, clawbackBeforeMonths: 3 }),
  ).includes("active clients only") &&
    timingHeadline(
      timing({ trigger: "immediate", requireActiveClient: true, clawbackBeforeMonths: 3 }),
    ).includes("clawback under 3 mo"),
);

// ============================================================================
console.log("\n[Timing \u00b7 the eight behaviours]");
// ============================================================================

// 1) Pay immediately
{
  const r = resolveCommissionTiming(ctx({ timing: timing({ trigger: "immediate" }) }));
  ok("immediate -> pending/released", r.status === "pending" && r.released);
  ok("immediate releaseDate == earnedDate", r.releaseDate === "2025-06-01");
  ok("immediate holdDays 0", r.holdDays === 0);
}

// 2) Pay after X days
{
  const t = timing({ trigger: "after_days", days: 30 });
  const held = resolveCommissionTiming(ctx({ timing: t, asOf: "2025-06-10" }));
  ok("after_days before release -> held", held.status === "held" && !held.released);
  ok("after_days computes releaseDate", held.releaseDate === "2025-07-01");
  ok("after_days holdDays = days", held.holdDays === 30);
  const rel = resolveCommissionTiming(ctx({ timing: t, asOf: "2025-07-15" }));
  ok("after_days on/after release -> pending", rel.status === "pending" && rel.released);
  const exact = resolveCommissionTiming(ctx({ timing: t, asOf: "2025-07-01" }));
  ok("after_days exactly on release date -> released", exact.released);
}

// 3) Pay after X months
{
  const t = timing({ trigger: "after_months", months: 2 });
  const held = resolveCommissionTiming(ctx({ timing: t, asOf: "2025-07-01" }));
  ok("after_months before release -> held", held.status === "held");
  ok("after_months releaseDate", held.releaseDate === "2025-08-01");
  const rel = resolveCommissionTiming(ctx({ timing: t, asOf: "2025-09-01" }));
  ok("after_months after release -> pending", rel.status === "pending");
}

// 4) Pay after X payments
{
  const t = timing({ trigger: "after_payments", payments: 3 });
  const notYet = resolveCommissionTiming(ctx({ timing: t, clientPaymentCount: 1 }));
  ok("after_payments not enough -> held", notYet.status === "held");
  ok("after_payments shows progress", notYet.reason.includes("1/3"));
  ok("after_payments has no fixed releaseDate", notYet.releaseDate === null);
  const enough = resolveCommissionTiming(ctx({ timing: t, clientPaymentCount: 3 }));
  ok("after_payments enough -> pending", enough.status === "pending");
  const more = resolveCommissionTiming(ctx({ timing: t, clientPaymentCount: 5 }));
  ok("after_payments over target -> pending", more.status === "pending");
}

// 5) Hold until approval
{
  const t = timing({ trigger: "on_approval" });
  const held = resolveCommissionTiming(ctx({ timing: t, asOf: "2030-01-01" }));
  ok("on_approval -> held regardless of time", held.status === "held" && !held.released);
  ok("on_approval reason", held.reason === "Held until approved");
  ok("on_approval releaseDate null", held.releaseDate === null);
  const overridden = resolveCommissionTiming(
    ctx({ timing: t, releasedOverride: true }),
  );
  ok("on_approval + override -> pending", overridden.status === "pending" && overridden.released);
}

// 6) Release after refund window
{
  const t = timing({ trigger: "after_refund_window", days: 14 });
  const inside = resolveCommissionTiming(ctx({ timing: t, asOf: "2025-06-10" }));
  ok("refund window inside -> held", inside.status === "held");
  ok("refund window releaseDate", inside.releaseDate === "2025-06-15");
  const passed_ = resolveCommissionTiming(ctx({ timing: t, asOf: "2025-06-20" }));
  ok("refund window passed -> pending", passed_.status === "pending");
}

// 7) Pay only if still active
{
  const t = timing({ trigger: "immediate", requireActiveClient: true });
  const paused = resolveCommissionTiming(ctx({ timing: t, clientStatus: "paused" }));
  ok("requireActive + paused -> held", paused.status === "held" && !paused.released);
  ok("requireActive reason names status", paused.reason.includes("paused"));
  const active = resolveCommissionTiming(ctx({ timing: t, clientStatus: "active" }));
  ok("requireActive + active -> pending", active.status === "pending");
}

// 8) Claw back if cancels early
{
  const t = timing({ trigger: "immediate", clawbackBeforeMonths: 3 });
  const clawed = resolveCommissionTiming(
    ctx({
      timing: t,
      clientStatus: "canceled",
      clientSignupDate: "2025-01-01",
      clientCanceledDate: "2025-02-15", // ~1 month < 3
    }),
  );
  ok("clawback inside window -> clawed_back", clawed.status === "clawed_back");
  ok("clawback not released", !clawed.released);
  ok("clawback reason present", !!clawed.clawbackReason && clawed.clawbackReason.includes("clawback"));

  const survived = resolveCommissionTiming(
    ctx({
      timing: t,
      clientStatus: "canceled",
      clientSignupDate: "2025-01-01",
      clientCanceledDate: "2025-06-01", // 5 months >= 3
    }),
  );
  ok("clawback outside window -> not clawed", survived.status !== "clawed_back");
  ok("survived cancellation still pays (immediate)", survived.status === "pending");

  const refunded = resolveCommissionTiming(
    ctx({
      timing: t,
      clientStatus: "refunded",
      clientSignupDate: "2025-01-01",
      clientCanceledDate: "2025-02-01",
    }),
  );
  ok("clawback also triggers on refunded", refunded.status === "clawed_back");

  // canceledDate unknown -> falls back to asOf for the window measurement
  const fallback = resolveCommissionTiming(
    ctx({
      timing: t,
      clientStatus: "canceled",
      clientSignupDate: "2025-01-01",
      clientCanceledDate: null,
      asOf: "2025-02-01",
    }),
  );
  ok("clawback uses asOf when canceledDate missing", fallback.status === "clawed_back");
}

// ============================================================================
console.log("\n[Timing \u00b7 priority + edge cases]");
// ============================================================================

// Clawback wins over an admin force-release.
{
  const t = timing({ trigger: "on_approval", clawbackBeforeMonths: 3 });
  const r = resolveCommissionTiming(
    ctx({
      timing: t,
      releasedOverride: true,
      clientStatus: "canceled",
      clientSignupDate: "2025-01-01",
      clientCanceledDate: "2025-02-01",
    }),
  );
  ok("clawback beats releasedOverride", r.status === "clawed_back");
}

// Override beats the active-client condition.
{
  const t = timing({ trigger: "immediate", requireActiveClient: true });
  const r = resolveCommissionTiming(
    ctx({ timing: t, clientStatus: "paused", releasedOverride: true }),
  );
  ok("override releases an inactive-client hold", r.status === "pending" && r.released);
}

// No clawback configured -> a cancellation does not reverse (immediate pays).
{
  const t = timing({ trigger: "immediate", clawbackBeforeMonths: 0 });
  const r = resolveCommissionTiming(ctx({ timing: t, clientStatus: "canceled" }));
  ok("no clawback window -> cancellation ignored", r.status === "pending");
}

ok("isHeld true for held", isHeld("held"));
ok("isHeld false for pending", !isHeld("pending"));
ok(
  "effectiveDate picks later of release/due",
  effectiveDate("2025-08-01", "2025-06-01") === "2025-08-01" &&
    effectiveDate(null, "2025-06-01") === "2025-06-01",
);

// ============================================================================
console.log("\n[Timing \u00b7 ledger integration]");
// ============================================================================

function sp(id: string, planId: string): Salesperson {
  return {
    id, name: id, email: "", phone: "", role: "salesperson", referralCode: "",
    status: "active", commissionPlanId: planId, weeklySalary: null,
    salaryStartDate: null, salaryEndDate: null, notes: "", source: "admin",
    approvalStatus: "approved", createdAt: "2025-01-01",
  };
}
function client(
  id: string, spId: string, signup: string,
  status: Client["status"] = "active", canceledDate: string | null = null,
): Client {
  return {
    id, companyName: id, contactName: "", email: "", phone: "", salespersonId: spId,
    signupDate: signup, setupFee: 2000, monthlySubscription: 200, status, canceledDate,
    notes: "", createdAt: signup,
  };
}
function pay(id: string, clientId: string, date: string, type: Payment["type"], amount: number, n: number | null): Payment {
  return { id, clientId, date, type, amount, paymentNumber: n, notes: "", createdAt: date };
}
function planWith(id: string, t: CommissionTiming): CommissionPlan {
  return {
    id, name: id, description: "", sampleSetupFee: 2000, sampleMonthly: 200,
    createdAt: "2025-01-01", timing: t,
    rules: [
      { id: `${id}_setup`, type: "setup_fee", mode: "percentage", value: 50 },
      { id: `${id}_resid`, type: "monthly_residual", startMonth: 1, endMonth: null, continueForever: true, valueType: "percentage", value: 10 },
    ],
  };
}

function baseData(plans: CommissionPlan[], salespeople: Salesperson[], clients: Client[], payments: Payment[]): AppData {
  return {
    salespeople, plans, clients, payments,
    commissions: [], payouts: [], version: 1,
    settings: { theme: "light", companyName: "T", assumptions: { avgSetupFee: 2000, avgMonthly: 200, closingsPerMonth: 5, monthlyChurnPct: 3, months: 60 } },
  } as AppData;
}

const TODAY = "2025-06-15";

// after_refund_window: an old setup fee is released, a fresh monthly is held.
{
  const plan = planWith("p_rw", timing({ trigger: "after_refund_window", days: 14 }));
  const data = baseData(
    [plan], [sp("s1", "p_rw")], [client("c1", "s1", "2025-01-01")],
    [
      pay("pay_setup", "c1", "2025-01-01", "setup_fee", 2000, null),   // old -> released
      pay("pay_fresh", "c1", "2025-06-10", "monthly_subscription", 200, 6), // within 14d -> held
    ],
  );
  const rows = recomputePaymentCommissions(data, TODAY);
  const setup = rows.find((r) => r.paymentId === "pay_setup");
  const fresh = rows.find((r) => r.paymentId === "pay_fresh");
  ok("integration: old setup released (pending)", setup?.status === "pending", setup?.status);
  ok("integration: fresh monthly held", fresh?.status === "held", fresh?.status);
  ok("integration: held row carries reason", !!fresh?.holdReason);
  ok("integration: held row carries releaseDate", fresh?.releaseDate === "2025-06-24");
}

// requireActiveClient: a paused client's commissions are all held.
{
  const plan = planWith("p_act", timing({ trigger: "immediate", requireActiveClient: true }));
  const data = baseData(
    [plan], [sp("s1", "p_act")], [client("c1", "s1", "2025-01-01", "paused")],
    [pay("pay_setup", "c1", "2025-01-01", "setup_fee", 2000, null)],
  );
  const rows = recomputePaymentCommissions(data, TODAY);
  ok("integration: paused client -> held", rows.every((r) => r.status === "held"));
}

// on_approval + admin release: held until releasedOverride flips it to pending.
{
  const plan = planWith("p_app", timing({ trigger: "on_approval" }));
  const data = baseData(
    [plan], [sp("s1", "p_app")], [client("c1", "s1", "2025-01-01")],
    [pay("pay_setup", "c1", "2025-01-01", "setup_fee", 2000, null)],
  );
  let rows = recomputePaymentCommissions(data, TODAY);
  ok("integration: on_approval starts held", rows.every((r) => r.status === "held"));

  // Simulate the RELEASE_COMMISSION action: set the sticky flag, recompute.
  const released = rows.map((r) => ({ ...r, releasedOverride: true }));
  rows = recomputePaymentCommissions({ ...data, commissions: released }, TODAY);
  ok("integration: release flag survives recompute -> pending", rows.every((r) => r.status === "pending"));
  ok("integration: releasedOverride preserved on row", rows.every((r) => r.releasedOverride === true));
}

// clawback: a client who cancels inside the window has commissions reversed.
{
  const plan = planWith("p_claw", timing({ trigger: "immediate", clawbackBeforeMonths: 3 }));
  const data = baseData(
    [plan], [sp("s1", "p_claw")],
    [client("c1", "s1", "2025-04-01", "canceled", "2025-05-01")], // 1 month < 3
    [pay("pay_setup", "c1", "2025-04-01", "setup_fee", 2000, null)],
  );
  const rows = recomputePaymentCommissions(data, TODAY);
  ok("integration: early cancel -> clawed_back", rows.every((r) => r.status === "clawed_back"));
  ok("integration: clawed_back carries reason", rows.every((r) => !!r.clawbackReason));
}

// A plan WITHOUT timing keeps the historical behaviour (everything pending).
{
  const plan: CommissionPlan = {
    id: "p_none", name: "p_none", description: "", sampleSetupFee: 2000, sampleMonthly: 200,
    createdAt: "2025-01-01",
    rules: [{ id: "r1", type: "setup_fee", mode: "percentage", value: 50 }],
  };
  const data = baseData(
    [plan], [sp("s1", "p_none")], [client("c1", "s1", "2025-01-01")],
    [pay("pay_setup", "c1", "2025-01-01", "setup_fee", 2000, null)],
  );
  const rows = recomputePaymentCommissions(data, TODAY);
  ok("integration: no timing -> pending (legacy preserved)", rows.every((r) => r.status === "pending"));
}

// fullLedger re-derives timing at display time (even with no recompute run).
{
  const plan = planWith("p_rw2", timing({ trigger: "after_refund_window", days: 14 }));
  const data = baseData(
    [plan], [sp("s1", "p_rw2")], [client("c1", "s1", "2025-01-01")],
    [pay("pay_fresh", "c1", "2025-06-10", "monthly_subscription", 200, 6)],
  );
  // Seed a stale "pending" commission directly (as if loaded from a snapshot).
  const stale = recomputePaymentCommissions(data, "2025-06-09").map((r) => ({ ...r, status: "pending" as const, holdReason: undefined, releaseDate: undefined }));
  const view = fullLedger({ ...data, commissions: stale });
  const fresh = view.find((r) => r.paymentId === "pay_fresh");
  // (display "today" is the real now, which is well past the window, so released)
  ok("integration: fullLedger re-stamps timing fields", fresh?.releaseDate === "2025-06-24");
}

console.log(`\n========================\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
