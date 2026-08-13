// ============================================================================
// CLAWBACKS  (pure decision core; tested in clawbacks.test.ts)
//
// When money comes back — a refund or a chargeback — the commission it paid has
// to come back too. HOW depends entirely on whether the rep has been paid yet,
// and getting that distinction wrong is how a commission system quietly loses
// money in one direction or the other:
//
//   NOT YET PAID (projected / held / pending / submitted / approved)
//     Nothing has left the business. The line is simply marked `clawed_back`
//     and stops being payable. No adjustment row is needed — you cannot deduct
//     money that was never sent.
//
//   ALREADY PAID
//     The money is gone. The paid line is HISTORY and must not be rewritten:
//     it says what was actually paid, and a payout batch, an export and an audit
//     trail all point at it. Instead a NEGATIVE adjustment line is booked
//     against the rep, which nets off their next payout. That is the
//     "deduction on the next cycle" the product promises, and it keeps the
//     ledger's sum equal to the rep's true balance at every point in time.
//
//   ALREADY CLAWED BACK
//     Do nothing. Refund webhooks are re-delivered, and a second reversal would
//     double-deduct.
//
// The decision is pure so it can be exercised over every status without a
// database. The caller (kleegr-sync) applies the plan inside one transaction.
// ============================================================================

import type { CommissionEntry, CommissionStatus } from "../../src/types/index.js";

/** The subset of a ledger row the clawback decision needs. */
export interface ClawbackCandidate {
  id: string;
  salespersonId: string;
  clientId: string | null;
  paymentId: string | null;
  ruleId: string | null;
  ruleType: CommissionEntry["ruleType"];
  ruleLabel: string;
  commissionAmount: number;
  status: CommissionStatus;
  isProjection: boolean;
  /** 'engine' rows are engine output; 'clawback' rows are reversals already booked. */
  entrySource?: string | null;
}

/** Statuses where the money has genuinely left the business. */
const PAID_STATUSES: CommissionStatus[] = ["paid"];

/** Statuses that are already reversed — reversing again would double-count. */
const ALREADY_REVERSED: CommissionStatus[] = ["clawed_back", "canceled", "rejected"];

export function isAlreadyPaid(status: CommissionStatus): boolean {
  return PAID_STATUSES.includes(status);
}

export function isAlreadyReversed(status: CommissionStatus): boolean {
  return ALREADY_REVERSED.includes(status);
}

export type ClawbackTrigger = "refund" | "chargeback" | "cancellation";

const TRIGGER_LABEL: Record<ClawbackTrigger, string> = {
  refund: "refund",
  chargeback: "chargeback",
  cancellation: "cancellation",
};

export interface ClawbackPlanInput {
  candidates: ClawbackCandidate[];
  trigger: ClawbackTrigger;
  /** ISO date the reversal is booked on. */
  asOf: string;
  /** Deterministic id factory, so the plan is reproducible in tests. */
  makeId?: (seed: string) => string;
}

export interface ClawbackPlan {
  /** Ids to mark `clawed_back` (unpaid money that simply stops being payable). */
  voidIds: string[];
  /** Negative ledger rows to insert against already-paid commissions. */
  adjustments: Array<
    CommissionEntry & { adjustmentOfEntryId: string; entrySource: "clawback" }
  >;
  /** Ids skipped because they were already reversed. */
  skippedIds: string[];
  /** Total value reversed, positive (voided + adjusted). */
  totalReversed: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Build the reversal plan for one refunded/charged-back payment.
 *
 * `makeId` defaults to a DETERMINISTIC id derived from the entry it reverses, so
 * a re-delivered webhook that somehow got past the delivery-id dedupe still
 * cannot insert a second adjustment for the same line: the primary key collides
 * and the insert is a no-op.
 */
export function planClawback(input: ClawbackPlanInput): ClawbackPlan {
  const { candidates, trigger, asOf } = input;
  const makeId = input.makeId ?? ((seed: string) => `cb_${seed}`);

  const voidIds: string[] = [];
  const skippedIds: string[] = [];
  const adjustments: ClawbackPlan["adjustments"] = [];
  let totalReversed = 0;

  for (const c of candidates) {
    // A reversal row is not itself reversible — otherwise a repeated refund
    // would claw back the clawback.
    if (c.entrySource === "clawback") {
      skippedIds.push(c.id);
      continue;
    }
    if (isAlreadyReversed(c.status)) {
      skippedIds.push(c.id);
      continue;
    }
    // A projection is a forecast, not an entitlement: it disappears on the next
    // recompute anyway, so there is nothing to reverse.
    if (c.isProjection) {
      skippedIds.push(c.id);
      continue;
    }
    if (c.commissionAmount === 0) {
      skippedIds.push(c.id);
      continue;
    }

    if (isAlreadyPaid(c.status)) {
      const amount = round2(-Math.abs(c.commissionAmount));
      adjustments.push({
        id: makeId(c.id),
        salespersonId: c.salespersonId,
        clientId: c.clientId,
        // Deliberately NOT attached to the reversed payment: this row is a
        // balance adjustment, not engine output, and must survive the next
        // recompute of that payment's lines.
        paymentId: null,
        paymentDate: asOf,
        paymentType: "adjustment",
        paymentAmount: 0,
        ruleId: c.ruleId,
        ruleType: c.ruleType,
        ruleLabel: `Clawback (${TRIGGER_LABEL[trigger]}) · ${c.ruleLabel}`,
        commissionValueType: "fixed",
        commissionValue: amount,
        commissionAmount: amount,
        // `pending` so it enters the payout pool and nets off the next cycle.
        status: "pending",
        dueDate: asOf,
        paidDate: null,
        notes: `Reverses ${c.id} after a ${TRIGGER_LABEL[trigger]}.`,
        isProjection: false,
        createdAt: asOf,
        adjustmentOfEntryId: c.id,
        entrySource: "clawback",
        clawbackReason: `Client ${TRIGGER_LABEL[trigger]}`,
      });
      totalReversed += Math.abs(c.commissionAmount);
    } else {
      voidIds.push(c.id);
      totalReversed += Math.abs(c.commissionAmount);
    }
  }

  return { voidIds, adjustments, skippedIds, totalReversed: round2(totalReversed) };
}
