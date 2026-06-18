// ============================================================================
// LEDGER HELPERS
//
// Turns the stored data into the views the UI needs:
//  - displayStatus(): projected-vs-pending logic based on due date
//  - computeProjectedLedger(): future residual rows for active clients
//  - recompute helpers used by the store when payments / salaries change
// ============================================================================

import {
  calculateCommissionForPayment,
  generateSalaryEntries,
  residualAmount,
  residualLabel,
  ruleAppliesToMonth,
} from "./commission-engine.js";
import { addMonthsISO, isoToDate, monthsSince, round2, todayISO } from "./format.js";
import {
  normalizeTiming,
  resolveCommissionTiming,
} from "./commission-timing.js";
import type {
  AppData,
  Client,
  CommissionEntry,
  CommissionStatus,
  MonthlyResidualRule,
} from "../types/index.js";

/** Statuses set by a human in the payout workflow — timing never overrides these. */
const MANUAL: CommissionStatus[] = [
  "submitted",
  "approved",
  "paid",
  "rejected",
  "canceled",
];

/** Count a client's qualifying (monthly) payments on/before `asOf`. */
function clientPaymentCount(
  data: AppData,
  clientId: string | null,
  asOf: string,
): number {
  if (!clientId) return 0;
  const cutoff = isoToDate(asOf).getTime();
  return data.payments.filter(
    (p) =>
      p.clientId === clientId &&
      p.type === "monthly_subscription" &&
      isoToDate(p.date).getTime() <= cutoff,
  ).length;
}

/**
 * Resolve a payment-derived commission's timing (hold / release / clawback) and
 * stamp the derived fields onto a NEW entry. Manual workflow statuses keep their
 * status (we still attach the display fields); otherwise timing owns the status.
 * Used by BOTH recompute (write time) and fullLedger (display time) so the
 * persisted snapshot and the on-screen view always agree.
 */
export function stampTiming(
  entry: CommissionEntry,
  data: AppData,
  today = todayISO(),
): CommissionEntry {
  // Salary rows and computed projections do not carry payment timing.
  if (entry.isProjection || entry.paymentType === "salary" || !entry.paymentId) {
    return entry;
  }
  const client = entry.clientId
    ? data.clients.find((c) => c.id === entry.clientId) ?? null
    : null;
  const sp = data.salespeople.find((s) => s.id === entry.salespersonId);
  const plan = sp?.commissionPlanId
    ? data.plans.find((p) => p.id === sp.commissionPlanId) ?? null
    : null;
  const timing = normalizeTiming(plan?.timing);

  const r = resolveCommissionTiming({
    timing,
    earnedDate: entry.paymentDate,
    asOf: today,
    clientStatus: client?.status ?? null,
    clientSignupDate: client?.signupDate ?? null,
    clientCanceledDate: client?.canceledDate ?? null,
    clientPaymentCount: clientPaymentCount(data, entry.clientId, today),
    releasedOverride: Boolean(entry.releasedOverride),
  });

  const derived: CommissionEntry = {
    ...entry,
    earnedDate: r.earnedDate,
    releaseDate: r.releaseDate,
    holdDays: r.holdDays,
    holdReason: r.reason,
    clawbackReason: r.clawbackReason,
    timingTrigger: r.trigger,
  };

  // A human-set workflow status (submitted/approved/paid/…) is authoritative.
  if (MANUAL.includes(entry.status)) return derived;
  return { ...derived, status: r.status };
}

/** Statuses that are "locked in" — not auto-derived from the due/release date. */
const LOCKED: CommissionStatus[] = [
  "submitted",
  "approved",
  "paid",
  "rejected",
  "canceled",
  "clawed_back",
  "held",
];

/**
 * Display status. Locked / timing-resolved states (held, clawed_back, workflow
 * states) are returned as-is. Otherwise a future release/due date shows as
 * Projected; today-or-earlier shows as Pending.
 */
export function displayStatus(
  entry: CommissionEntry,
  today = todayISO(),
): CommissionStatus {
  if (LOCKED.includes(entry.status)) return entry.status;
  const gate = entry.releaseDate || entry.dueDate;
  const due = isoToDate(gate).getTime();
  const now = isoToDate(today).getTime();
  return due > now ? "projected" : "pending";
}

/** Regenerate all payment-derived commission entries, preserving workflow status. */
export function recomputePaymentCommissions(
  data: AppData,
  today = todayISO(),
): CommissionEntry[] {
  const planById = new Map(data.plans.map((p) => [p.id, p]));
  const clientById = new Map(data.clients.map((c) => [c.id, c]));
  const spById = new Map(data.salespeople.map((s) => [s.id, s]));

  // Preserve human-set workflow status + admin release flag by a stable key.
  // Auto states (projected/pending/held/clawed_back) are re-derived by timing.
  const prior = new Map<
    string,
    { status: CommissionStatus; paidDate: string | null; releasedOverride: boolean }
  >();
  for (const e of data.commissions) {
    if (e.paymentId) {
      prior.set(`${e.paymentId}:${e.ruleId}`, {
        status: e.status,
        paidDate: e.paidDate,
        releasedOverride: Boolean(e.releasedOverride),
      });
    }
  }

  const fresh: CommissionEntry[] = [];
  for (const pay of data.payments) {
    const client = clientById.get(pay.clientId);
    if (!client || !client.salespersonId) continue;
    const sp = spById.get(client.salespersonId);
    if (!sp || !sp.commissionPlanId) continue;
    const plan = planById.get(sp.commissionPlanId);
    if (!plan) continue;

    for (const e of calculateCommissionForPayment(pay, client, sp, plan)) {
      const p = prior.get(`${e.paymentId}:${e.ruleId}`);
      if (p) {
        if (MANUAL.includes(p.status)) e.status = p.status;
        e.paidDate = p.paidDate;
        e.releasedOverride = p.releasedOverride;
      }
      fresh.push(stampTiming(e, data, today));
    }
  }

  // Keep existing salary entries (managed separately).
  const salary = data.commissions.filter((e) => e.paymentType === "salary");
  return [...fresh, ...salary];
}

/** Regenerate salary ledger entries from salespeople, preserving workflow status. */
export function recomputeSalaryEntries(data: AppData): CommissionEntry[] {
  const today = todayISO();
  const priorByKey = new Map<string, CommissionEntry>();
  for (const e of data.commissions) {
    if (e.paymentType === "salary") priorByKey.set(e.id, e);
  }

  const salary: CommissionEntry[] = [];
  for (const sp of data.salespeople) {
    for (const e of generateSalaryEntries(sp, today)) {
      const prior = priorByKey.get(e.id);
      if (prior) {
        e.status = prior.status;
        e.paidDate = prior.paidDate;
        e.notes = prior.notes;
      }
      salary.push(e);
    }
  }

  const nonSalary = data.commissions.filter((e) => e.paymentType !== "salary");
  return [...nonSalary, ...salary];
}

/**
 * Future, projected residual rows for active clients — beyond what they have
 * already been billed for. Computed fresh (not persisted) so the projection
 * always reflects current plans + assumptions.
 */
export function computeProjectedLedger(
  data: AppData,
  futureMonths = 24,
): CommissionEntry[] {
  const today = todayISO();
  const planById = new Map(data.plans.map((p) => [p.id, p]));
  const spById = new Map(data.salespeople.map((s) => [s.id, s]));
  const out: CommissionEntry[] = [];

  for (const client of data.clients) {
    if (client.status !== "active") continue;
    if (!client.salespersonId) continue;
    const sp = spById.get(client.salespersonId);
    if (!sp || sp.status !== "active" || !sp.commissionPlanId) continue;
    const plan = planById.get(sp.commissionPlanId);
    if (!plan) continue;

    const residuals = plan.rules.filter(
      (r): r is MonthlyResidualRule => r.type === "monthly_residual",
    );
    if (residuals.length === 0) continue;

    const ageNow = Math.max(0, monthsSince(client.signupDate)); // whole months elapsed
    const startN = ageNow + 1;

    for (let n = startN; n < startN + futureMonths; n++) {
      const dueDate = addMonthsISO(client.signupDate, n - 1);
      if (isoToDate(dueDate).getTime() <= isoToDate(today).getTime()) continue;

      for (const r of residuals) {
        if (!ruleAppliesToMonth(r, n)) continue;
        const amount = round2(residualAmount(r, client.monthlySubscription));
        out.push({
          id: `proj_${client.id}_${n}_${r.id}`,
          salespersonId: sp.id,
          clientId: client.id,
          paymentId: null,
          paymentDate: dueDate,
          paymentType: "monthly_subscription",
          paymentAmount: client.monthlySubscription,
          ruleId: r.id,
          ruleType: "monthly_residual",
          ruleLabel: residualLabel(r),
          commissionValueType: r.valueType,
          commissionValue: r.value,
          commissionAmount: amount,
          status: "projected",
          dueDate,
          paidDate: null,
          notes: `Projected · month ${n}`,
          isProjection: true,
          createdAt: today,
        });
      }
    }
  }
  return out;
}

/** Convenience: every ledger row (real + projected) for views that want both. */
export function fullLedger(data: AppData, futureMonths = 24): CommissionEntry[] {
  const today = todayISO();
  // Re-derive timing for the real (payment-backed) rows so the view is correct
  // even after a plain reload that did not run recompute. Projections + salary
  // pass through stampTiming untouched.
  const real = data.commissions.map((e) => stampTiming(e, data, today));
  return [...real, ...computeProjectedLedger(data, futureMonths)];
}

export function clientLabel(c: Client | undefined): string {
  return c ? c.companyName : "—";
}
