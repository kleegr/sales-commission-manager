// ============================================================================
// GOALS  (pure progress + motivational projection math)
//
// No UI, no storage, no database — just deterministic functions over AppData and
// a Goal. Used by BOTH the salesperson portal (live projections) and the
// /api/goals server (computing each goal's `actual`), so progress is defined in
// exactly one place. Covered by goals.test.ts.
//
// Progress is always COMPUTED from real data (payments / clients / commissions),
// never stored, so it reflects the live ledger the moment anything changes.
// ============================================================================

import type {
  AppData,
  CommissionPlan,
  Goal,
  GoalMetric,
  Milestone,
} from "../types";
import { projectPlanForClient } from "./commission-engine";

// ---------------------------------------------------------------------------
// Date helpers (string math on yyyy-mm-dd to avoid timezone drift)
// ---------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");

/** Days in a given 1-based month of a year. */
function daysInMonth(year: number, month1: number): number {
  return new Date(year, month1, 0).getDate(); // month1 as the "next" month's day 0
}

/** First and last day (inclusive) of the calendar month containing `iso`. */
export function monthRange(iso: string): { start: string; end: string } {
  const [y, m] = iso.split("-").map(Number);
  return { start: `${y}-${pad(m)}-01`, end: `${y}-${pad(m)}-${pad(daysInMonth(y, m))}` };
}

/** First and last day (inclusive) of the calendar quarter containing `iso`. */
export function quarterRange(iso: string): { start: string; end: string } {
  const [y, m] = iso.split("-").map(Number);
  const qStartMonth = Math.floor((m - 1) / 3) * 3 + 1; // 1,4,7,10
  const qEndMonth = qStartMonth + 2;
  return {
    start: `${y}-${pad(qStartMonth)}-01`,
    end: `${y}-${pad(qEndMonth)}-${pad(daysInMonth(y, qEndMonth))}`,
  };
}

/** Inclusive yyyy-mm-dd range test; null bounds are open. */
export function inDateRange(iso: string, start: string | null, end: string | null): boolean {
  if (!iso) return false;
  const d = iso.slice(0, 10);
  if (start && d < start) return false;
  if (end && d > end) return false;
  return true;
}

/**
 * Resolve a goal's effective [start, end] window for a given "today".
 *   - custom    -> the stored period_start/period_end (either may be open/null)
 *   - monthly   -> the calendar month of period_start (if set) else of `today`
 *   - quarterly -> the calendar quarter of period_start (if set) else of `today`
 */
export function resolveGoalPeriod(goal: Goal, today: string): { start: string | null; end: string | null } {
  const anchor = (goal.periodStart || today).slice(0, 10);
  if (goal.period === "monthly") return monthRange(anchor);
  if (goal.period === "quarterly") return quarterRange(anchor);
  return { start: goal.periodStart, end: goal.periodEnd }; // custom
}

// ---------------------------------------------------------------------------
// Actual value for a metric over a scope + period
// ---------------------------------------------------------------------------

const EARNED_STATUSES = ["pending", "submitted", "approved", "paid"];

/**
 * The real, current value of `metric` for the salespeople in `spIds`
 * (null = the whole tenant) within [start, end].
 */
export function metricActual(
  metric: GoalMetric,
  data: AppData,
  spIds: Set<string> | null,
  period: { start: string | null; end: string | null },
): number {
  const inScope = (salespersonId: string | null): boolean =>
    spIds === null ? true : !!salespersonId && spIds.has(salespersonId);

  // client_id -> salesperson_id (so payments can be scoped via their client)
  const clientSp = new Map<string, string | null>();
  for (const c of data.clients) clientSp.set(c.id, c.salespersonId);

  switch (metric) {
    case "revenue": {
      let total = 0;
      for (const p of data.payments) {
        if (!inScope(clientSp.get(p.clientId) ?? null)) continue;
        if (!inDateRange(p.date, period.start, period.end)) continue;
        if (p.type === "refund") total -= p.amount;
        else total += p.amount; // setup_fee | monthly_subscription | adjustment
      }
      return round2(total);
    }
    case "clients_closed":
    case "referrals": {
      let n = 0;
      for (const c of data.clients) {
        if (!inScope(c.salespersonId)) continue;
        if (!inDateRange(c.signupDate, period.start, period.end)) continue;
        n++;
      }
      return n;
    }
    case "mrr": {
      // Current run-rate: active clients' monthly subscription (period-independent).
      let total = 0;
      for (const c of data.clients) {
        if (!inScope(c.salespersonId)) continue;
        if (c.status === "active") total += c.monthlySubscription;
      }
      return round2(total);
    }
    case "commission_earned": {
      let total = 0;
      for (const e of data.commissions) {
        if (e.isProjection) continue;
        if (!inScope(e.salespersonId)) continue;
        if (!EARNED_STATUSES.includes(e.status)) continue;
        const when = e.paymentDate || e.dueDate;
        if (!inDateRange(when, period.start, period.end)) continue;
        total += e.commissionAmount;
      }
      return round2(total);
    }
    case "activity": {
      // Proxy for logged activity until a dedicated activity table exists:
      // new clients signed + payments recorded, in the period.
      let n = 0;
      for (const c of data.clients) {
        if (inScope(c.salespersonId) && inDateRange(c.signupDate, period.start, period.end)) n++;
      }
      for (const p of data.payments) {
        if (inScope(clientSp.get(p.clientId) ?? null) && inDateRange(p.date, period.start, period.end)) n++;
      }
      return n;
    }
    default:
      return 0;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Progress + pace
// ---------------------------------------------------------------------------

export interface GoalProgress {
  actual: number;
  target: number;
  /** 0–100, clamped. */
  pct: number;
  /** max(0, target − actual). */
  remaining: number;
  reached: boolean;
}

export function goalProgress(actual: number, target: number): GoalProgress {
  const safeTarget = target > 0 ? target : 0;
  const pct = safeTarget > 0 ? Math.min(100, Math.max(0, (actual / safeTarget) * 100)) : actual > 0 ? 100 : 0;
  return {
    actual: round2(actual),
    target: safeTarget,
    pct: Math.round(pct),
    remaining: round2(Math.max(0, safeTarget - actual)),
    reached: safeTarget > 0 ? actual >= safeTarget : false,
  };
}

export interface PaceProjection {
  /** Fraction of the period elapsed, 0–1 (1 when the period is open/unbounded). */
  elapsedFraction: number;
  /** Linear projection of the end-of-period value at the current pace. */
  projectedEnd: number;
  /** True if the projected end meets or beats the target. */
  onTrack: boolean;
}

/**
 * Project the end-of-period value assuming the current pace continues. For a
 * bounded period, scales the actual by (periodLength / elapsed). For an open or
 * not-yet-started period, returns the actual as-is.
 */
export function paceProjection(
  actual: number,
  target: number,
  period: { start: string | null; end: string | null },
  today: string,
): PaceProjection {
  const t = today.slice(0, 10);
  if (!period.start || !period.end) {
    return { elapsedFraction: 1, projectedEnd: round2(actual), onTrack: target > 0 ? actual >= target : true };
  }
  const totalDays = daysBetween(period.start, period.end) + 1;
  const elapsedDaysRaw = daysBetween(period.start, t) + 1;
  const elapsedDays = Math.min(totalDays, Math.max(0, elapsedDaysRaw));
  const elapsedFraction = totalDays > 0 ? elapsedDays / totalDays : 1;
  const projectedEnd = elapsedFraction > 0 ? round2(actual / elapsedFraction) : round2(actual);
  return {
    elapsedFraction: Math.round(elapsedFraction * 100) / 100,
    projectedEnd,
    onTrack: target > 0 ? projectedEnd >= target : true,
  };
}

/** Whole-day difference b − a for two yyyy-mm-dd strings (can be negative). */
export function daysBetween(aIso: string, bIso: string): number {
  const a = new Date(aIso.slice(0, 10) + "T00:00:00Z").getTime();
  const b = new Date(bIso.slice(0, 10) + "T00:00:00Z").getTime();
  return Math.round((b - a) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Motivational projections
// ---------------------------------------------------------------------------

/**
 * Estimated first-12-months commission a single new client at (setupFee,
 * monthly) would earn under `plan`. Multiply by N for "close N more deals".
 * Returns 0 when there is no plan.
 */
export function projectedCommissionPerDeal(
  plan: CommissionPlan | null | undefined,
  setupFee: number,
  monthly: number,
): number {
  if (!plan) return 0;
  return round2(projectPlanForClient(plan, { setupFee, monthlySubscription: monthly, horizon: 12 }).total12);
}

export interface MilestoneView extends Milestone {
  achieved: boolean;
  remaining: number;
}

/** Annotate a goal's milestones (ordered by threshold) against its actual value. */
export function milestoneViews(milestones: Milestone[], actual: number): MilestoneView[] {
  return [...milestones]
    .sort((a, b) => a.thresholdValue - b.thresholdValue)
    .map((m) => ({ ...m, achieved: actual >= m.thresholdValue, remaining: round2(Math.max(0, m.thresholdValue - actual)) }));
}

/** The next not-yet-achieved milestone for a goal, or null if all are reached. */
export function nextMilestone(milestones: Milestone[], actual: number): MilestoneView | null {
  return milestoneViews(milestones, actual).find((m) => !m.achieved) ?? null;
}
