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
} from "./commission-engine";
import { addMonthsISO, isoToDate, monthsSince, round2, todayISO } from "./format";
import type {
  AppData,
  Client,
  CommissionEntry,
  CommissionStatus,
  MonthlyResidualRule,
} from "../types";

/** Statuses that are "locked in" — not auto-derived from the due date. */
const LOCKED: CommissionStatus[] = [
  "submitted",
  "approved",
  "paid",
  "rejected",
  "canceled",
  "clawed_back",
];

/**
 * Spec rule: future due date -> Projected; due today/earlier -> Pending,
 * unless the entry has already moved into a locked workflow state.
 */
export function displayStatus(
  entry: CommissionEntry,
  today = todayISO(),
): CommissionStatus {
  if (LOCKED.includes(entry.status)) return entry.status;
  const due = isoToDate(entry.dueDate).getTime();
  const now = isoToDate(today).getTime();
  return due > now ? "projected" : "pending";
}

/** Regenerate all payment-derived commission entries, preserving workflow status. */
export function recomputePaymentCommissions(data: AppData): CommissionEntry[] {
  const planById = new Map(data.plans.map((p) => [p.id, p]));
  const clientById = new Map(data.clients.map((c) => [c.id, c]));
  const spById = new Map(data.salespeople.map((s) => [s.id, s]));

  // Preserve prior status by a stable key (paymentId + ruleId).
  const priorStatus = new Map<string, { status: CommissionStatus; paidDate: string | null }>();
  for (const e of data.commissions) {
    if (e.paymentId) {
      priorStatus.set(`${e.paymentId}:${e.ruleId}`, {
        status: e.status,
        paidDate: e.paidDate,
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
      const prior = priorStatus.get(`${e.paymentId}:${e.ruleId}`);
      if (prior) {
        e.status = prior.status;
        e.paidDate = prior.paidDate;
      }
      fresh.push(e);
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
  return [...data.commissions, ...computeProjectedLedger(data, futureMonths)];
}

export function clientLabel(c: Client | undefined): string {
  return c ? c.companyName : "—";
}
