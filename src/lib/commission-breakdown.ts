// ============================================================================
// COMMISSION BREAKDOWN  (pure; tested in commission-breakdown.test.ts)
//
// Turns one ledger line into the arithmetic that produced it, in the order a
// person would do it on paper:
//
//     Client paid $1,000 (setup fee)
//     Your plan pays 10% of the setup fee
//     10% × $1,000
//     = $100
//
// WHY THIS EXISTS
// ---------------
// The engine is deterministic precisely so that every dollar can be traced back
// to a specific rule — but a rep looking at "$100" in the ledger cannot see any
// of that. Disputes over commission are almost never about the engine being
// wrong; they are about the rep not being able to check it. This module is the
// check.
//
// It DERIVES the explanation from the stored row rather than recomputing the
// amount. That distinction matters: if it recomputed, it would show what the
// rules say TODAY, and quietly disagree with a line that was priced under an
// older version of the plan. Showing the stored numbers means the breakdown
// always explains the money that was actually booked. `verified` reports
// whether the parts still multiply out to the total, so a genuine mismatch is
// surfaced instead of hidden.
// ============================================================================

import type {
  Client,
  CommissionEntry,
  CommissionPlan,
  Rule,
} from "../types";
import { normalizeTiming, TRIGGER_LABEL } from "./commission-timing";
import { formatCurrency, formatDate, round2 } from "./format";

/** One line of the explanation. `value` is shown right-aligned when present. */
export interface BreakdownStep {
  label: string;
  detail?: string;
  value?: string;
  /** The final line — rendered as the total. */
  total?: boolean;
}

export interface CommissionBreakdown {
  title: string;
  /** e.g. "10% × $1,000" — the one-line version. */
  formula: string;
  steps: BreakdownStep[];
  amount: number;
  /** Plain-English status + timing explanation. */
  timing: string[];
  /**
   * False when the stored parts do not multiply out to the stored total, which
   * means the row was written by something other than the current engine. Shown
   * rather than silently corrected.
   */
  verified: boolean;
}

const PAYMENT_LABEL: Record<string, string> = {
  setup_fee: "setup fee",
  monthly_subscription: "subscription payment",
  refund: "refund",
  adjustment: "adjustment",
  salary: "salary",
};

const STATUS_EXPLANATION: Record<string, string> = {
  projected: "Projected — this is a forecast from your plan, not money you have earned yet.",
  held: "Held — earned, but not payable yet.",
  pending: "Available — earned and released; it can go into your next payout.",
  submitted: "Submitted — included in a payout that is waiting for approval.",
  approved: "Approved — cleared for payment.",
  paid: "Paid.",
  rejected: "Rejected — the payout it belonged to was turned down.",
  canceled: "Canceled.",
  clawed_back: "Clawed back — the client's money was refunded or charged back.",
};

/** Find the rule that produced a line, by id first and then by type. */
export function findRule(plan: CommissionPlan | undefined, entry: CommissionEntry): Rule | undefined {
  if (!plan) return undefined;
  if (entry.ruleId) {
    const byId = plan.rules.find((r) => r.id === entry.ruleId);
    if (byId) return byId;
  }
  // A rule can be edited or replaced; falling back to type keeps the
  // explanation useful instead of blank.
  return plan.rules.find((r) => r.type === entry.ruleType);
}

/** "70%" or "$150", depending on how the rule expresses its value. */
export function formatRate(entry: CommissionEntry): string {
  return entry.commissionValueType === "percentage"
    ? `${entry.commissionValue}%`
    : formatCurrency(Math.abs(entry.commissionValue));
}

/**
 * Do the stored parts still produce the stored total?
 *
 * Only meaningful for a percentage line — a fixed line's "rate" IS its amount,
 * and a clawback adjustment is a booked reversal rather than a calculation.
 */
export function verifyAmount(entry: CommissionEntry): boolean {
  if (entry.commissionValueType !== "percentage") return true;
  const expected = round2((entry.paymentAmount * entry.commissionValue) / 100);
  return Math.abs(expected - entry.commissionAmount) < 0.011;
}

function timingLines(entry: CommissionEntry, plan: CommissionPlan | undefined): string[] {
  const out: string[] = [];
  out.push(STATUS_EXPLANATION[entry.status] ?? `Status: ${entry.status}.`);

  if (entry.holdReason) out.push(entry.holdReason);

  const trigger = entry.timingTrigger ?? normalizeTiming(plan?.timing).trigger;
  if (trigger && trigger !== "immediate") {
    out.push(`Release rule: ${TRIGGER_LABEL[trigger]}.`);
  }
  if (entry.releaseDate) {
    out.push(`Becomes payable on ${formatDate(entry.releaseDate)}.`);
  }
  if (entry.releasedOverride) {
    out.push("An admin released this early.");
  }
  if (entry.clawbackReason) out.push(entry.clawbackReason);
  if (entry.paidDate) out.push(`Paid on ${formatDate(entry.paidDate)}.`);
  return out;
}

/**
 * Build the step-by-step explanation for one ledger line.
 *
 * `plan` and `client` are optional context: without them the breakdown still
 * works (every number it needs is on the row itself), it just cannot name the
 * client or quote the plan's timing.
 */
export function buildBreakdown(
  entry: CommissionEntry,
  plan?: CommissionPlan,
  client?: Client,
): CommissionBreakdown {
  const steps: BreakdownStep[] = [];
  const amount = entry.commissionAmount;
  const isNegative = amount < 0;
  const rule = findRule(plan, entry);
  const who = client?.companyName ?? "The client";

  // ---- 1. what happened ---------------------------------------------------
  if (entry.ruleType === "salary") {
    steps.push({
      label: "Weekly salary",
      detail: "Paid on your own salary schedule, not tied to a client payment.",
      value: formatCurrency(entry.paymentAmount),
    });
  } else if (isNegative) {
    // A clawback adjustment reverses a line rather than calculating a new one.
    steps.push({
      label: "Reversal",
      detail: entry.notes || `${who}'s money was returned, so the commission it paid is reversed.`,
      value: formatCurrency(Math.abs(amount)),
    });
  } else {
    const kind = PAYMENT_LABEL[entry.paymentType] ?? "payment";
    const monthNote =
      entry.paymentType === "monthly_subscription" && entry.ruleLabel
        ? entry.ruleLabel.replace(/^Residual · /, "")
        : undefined;
    steps.push({
      label: `${who} paid a ${kind}`,
      detail: [formatDate(entry.paymentDate), monthNote].filter(Boolean).join(" · ") || undefined,
      value: formatCurrency(entry.paymentAmount),
    });
  }

  // ---- 2. which rule applied ----------------------------------------------
  if (entry.ruleLabel && !isNegative) {
    steps.push({
      label: "Your plan's rule",
      detail: entry.ruleLabel,
      value: entry.ruleType === "salary" ? undefined : formatRate(entry),
    });
  }

  // ---- 3. the arithmetic ---------------------------------------------------
  let formula: string;
  if (isNegative) {
    formula = `−${formatCurrency(Math.abs(amount))}`;
  } else if (entry.commissionValueType === "percentage") {
    formula = `${entry.commissionValue}% × ${formatCurrency(entry.paymentAmount)}`;
    steps.push({
      label: "The calculation",
      detail: `${entry.commissionValue}% of ${formatCurrency(entry.paymentAmount)}`,
      value: formatCurrency(amount),
    });
  } else {
    // A flat rule pays its own amount, so there is nothing to multiply.
    formula = formatCurrency(Math.abs(amount));
    steps.push({
      label: "The calculation",
      detail: "A flat amount — nothing is multiplied.",
      value: formatCurrency(amount),
    });
  }

  steps.push({
    label: isNegative ? "Deducted from your balance" : "Your commission",
    value: isNegative ? `−${formatCurrency(Math.abs(amount))}` : formatCurrency(amount),
    total: true,
  });

  const title = isNegative
    ? "Clawback"
    : rule
      ? entry.ruleLabel || "Commission"
      : entry.ruleLabel || "Commission";

  return {
    title,
    formula,
    steps,
    amount,
    timing: timingLines(entry, plan),
    verified: verifyAmount(entry),
  };
}
