// ============================================================================
// PLAN ANALYTICS
//
// Thin, pure selectors that turn a CommissionPlan (plus the people assigned to
// it) into the small derived facts the Plans list, the expanded preview, and
// the assignments view need. Everything here is built on the deterministic
// commission-engine — there is no new commission math, no randomness, and no
// state. Keeping it separate from the engine (pure money math) and the store
// (state) means the list/cards stay thin and consistent.
// ============================================================================

import type {
  Client,
  CommissionPlan,
  MonthlyResidualRule,
  ProjectionAssumptions,
  Rule,
  RuleType,
  Salesperson,
  SetupFeeRule,
} from "../types";
import {
  projectPlanForClient,
  residualLabel,
  ruleHeadline,
  setupFeeLabel,
  type PlanProjection,
} from "./commission-engine";
import { normalizeTiming } from "./commission-timing";
import { formatCurrency } from "./format";

export const RULE_TYPE_ORDER: RuleType[] = [
  "setup_fee",
  "signup_bonus",
  "monthly_residual",
  "salary",
];

export const RULE_TYPE_LABEL: Record<RuleType, string> = {
  setup_fee: "Setup fee",
  signup_bonus: "Signup bonus",
  monthly_residual: "Monthly residual",
  salary: "Salary",
};

export const RULE_TYPE_TONE: Record<
  RuleType,
  "blue" | "violet" | "green" | "amber"
> = {
  setup_fee: "blue",
  signup_bonus: "violet",
  monthly_residual: "green",
  salary: "amber",
};

/** Hex colors for charts, aligned with the badge tones above. */
export const RULE_TYPE_COLOR: Record<RuleType, string> = {
  setup_fee: "#3366ff", // brand blue
  signup_bonus: "#8b5cf6", // violet
  monthly_residual: "#16a34a", // emerald
  salary: "#f59e0b", // amber
};

/** Distinct rule types present in a plan, in a stable display order. */
export function planRuleTypes(plan: CommissionPlan): RuleType[] {
  const present = new Set(plan.rules.map((r) => r.type));
  return RULE_TYPE_ORDER.filter((t) => present.has(t));
}

// ----------------------------------------------------------------------------
// Per-rule-type summaries for cards / table rows
// ----------------------------------------------------------------------------

export interface PlanRuleSummary {
  setup: string | null;
  signupBonus: string | null;
  residual: string | null;
  salary: string | null;
  ruleCount: number;
}

/**
 * One short headline per rule family, for the dense card/table view. When a
 * plan has several residual ranges they're collapsed into a single "N ranges"
 * note so the card stays scannable; the first range's wording is kept.
 */
export function summarizePlanRules(plan: CommissionPlan): PlanRuleSummary {
  const setupRule = plan.rules.find(
    (r): r is SetupFeeRule => r.type === "setup_fee" && r.mode !== "none",
  );
  const bonusRule = plan.rules.find((r) => r.type === "signup_bonus");
  const residuals = plan.rules.filter(
    (r): r is MonthlyResidualRule => r.type === "monthly_residual",
  );
  const salaryRule = plan.rules.find((r) => r.type === "salary");

  const residual =
    residuals.length === 0
      ? null
      : residuals.length === 1
        ? residualLabel(residuals[0])
        : `${residualLabel(residuals[0])} (+${residuals.length - 1} more range${
            residuals.length - 1 === 1 ? "" : "s"
          })`;

  return {
    setup: setupRule ? setupFeeLabel(setupRule) : null,
    signupBonus: bonusRule ? ruleHeadline(bonusRule) : null,
    residual,
    salary: salaryRule ? ruleHeadline(salaryRule) : null,
    ruleCount: plan.rules.length,
  };
}

// ----------------------------------------------------------------------------
// Projected payout for a single client of this plan (sample-based)
// ----------------------------------------------------------------------------

export interface PlanProjectedTotals {
  projection: PlanProjection;
  upfront: number; // setup commission + signup bonus (month 1)
  total12: number;
  total24: number;
  total60: number;
  /** The sample inputs the totals were computed from (for tooltips/labels). */
  setupFee: number;
  monthly: number;
}

/**
 * Per-client projected payout using the plan's stored sample inputs, falling
 * back to the tenant's assumptions when a plan has no samples. This is what the
 * list sorts and labels by — clearly a "per one client" sample, never a
 * guarantee.
 */
export function planProjectedTotals(
  plan: CommissionPlan,
  assumptions?: ProjectionAssumptions,
): PlanProjectedTotals {
  const setupFee = plan.sampleSetupFee || assumptions?.avgSetupFee || 0;
  const monthly = plan.sampleMonthly || assumptions?.avgMonthly || 0;
  const projection = projectPlanForClient(plan, {
    setupFee,
    monthlySubscription: monthly,
    horizon: 60,
  });
  return {
    projection,
    upfront: projection.setupFeeCommission + projection.signupBonus,
    total12: projection.total12,
    total24: projection.total24,
    total60: projection.total60,
    setupFee,
    monthly,
  };
}

// ----------------------------------------------------------------------------
// Commission split by rule type (for the "where the money comes from" chart)
// ----------------------------------------------------------------------------

export interface RuleTypeSlice {
  type: RuleType;
  label: string;
  color: string;
  amount: number;
}

/**
 * Bucket a per-client projection's lifetime total by rule family. Useful for a
 * single, non-overwhelming "commission by rule type" chart.
 */
export function commissionByRuleType(projection: PlanProjection): RuleTypeSlice[] {
  const totals: Record<RuleType, number> = {
    setup_fee: 0,
    signup_bonus: 0,
    monthly_residual: 0,
    salary: 0,
  };
  for (const m of projection.months) {
    for (const line of m.lines) {
      totals[line.ruleType] += line.amount;
    }
  }
  return RULE_TYPE_ORDER.filter((t) => totals[t] > 0).map((t) => ({
    type: t,
    label: RULE_TYPE_LABEL[t],
    color: RULE_TYPE_COLOR[t],
    amount: Math.round(totals[t] * 100) / 100,
  }));
}

// ----------------------------------------------------------------------------
// Assignments — who is on this plan
// ----------------------------------------------------------------------------

export interface PlanAssignment {
  person: Salesperson;
  clientCount: number;
  activeClientCount: number;
}

/** Salespeople / affiliates / partners assigned to this plan, with client counts. */
export function assignmentsForPlan(
  plan: CommissionPlan,
  salespeople: Salesperson[],
  clients: Client[],
): PlanAssignment[] {
  return salespeople
    .filter((s) => s.commissionPlanId === plan.id)
    .map((person) => {
      const mine = clients.filter((c) => c.salespersonId === person.id);
      return {
        person,
        clientCount: mine.length,
        activeClientCount: mine.filter((c) => c.status === "active").length,
      };
    });
}

export interface PlanUsage {
  /** draft: no rules yet · unused: has rules but nobody assigned · active: in use */
  kind: "draft" | "unused" | "active";
  label: string;
  total: number;
  active: number;
}

/**
 * Derived plan "status". The data model has no explicit active flag on a plan,
 * so we report a truthful, useful usage state instead of inventing one:
 * whether the plan is fully built and whether anyone is actually on it.
 */
export function planUsage(
  plan: CommissionPlan,
  salespeople: Salesperson[],
): PlanUsage {
  const assigned = salespeople.filter((s) => s.commissionPlanId === plan.id);
  const active = assigned.filter((s) => s.status === "active").length;
  if (plan.rules.length === 0) {
    return { kind: "draft", label: "Draft", total: assigned.length, active };
  }
  if (assigned.length === 0) {
    return { kind: "unused", label: "Not assigned", total: 0, active: 0 };
  }
  return {
    kind: "active",
    label: "In use",
    total: assigned.length,
    active,
  };
}

// ----------------------------------------------------------------------------
// Timing flags for quick badges
// ----------------------------------------------------------------------------

export interface PlanTimingFlags {
  hasTiming: boolean; // anything other than pay-immediately
  hasHold: boolean; // a delay / approval / refund-window gate
  hasClawback: boolean;
  activeOnly: boolean;
}

export function planTimingFlags(plan: CommissionPlan): PlanTimingFlags {
  const t = normalizeTiming(plan.timing);
  const hasHold = t.trigger !== "immediate";
  const hasClawback = t.clawbackBeforeMonths > 0;
  return {
    hasTiming: hasHold || hasClawback || t.requireActiveClient,
    hasHold,
    hasClawback,
    activeOnly: t.requireActiveClient,
  };
}

/** Convenience: total projected first-year exposure across a person's plan. */
export function formatTotals(t: PlanProjectedTotals): {
  upfront: string;
  y1: string;
  y2: string;
} {
  return {
    upfront: formatCurrency(t.upfront),
    y1: formatCurrency(t.total12),
    y2: formatCurrency(t.total24),
  };
}
