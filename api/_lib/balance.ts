// ============================================================================
// REP BALANCE  (pure reconciliation; tested in balance.test.ts)
//
// What a salesperson may actually ask to be paid, and why. This is the number a
// rep sees on the "Request withdrawal" card, so it has to be defensible line by
// line — a balance a rep cannot reconcile against their own ledger is worse
// than no balance at all.
//
// THE COMPOSITION
// ---------------
// Everything starts from the ledger rows in the PENDING pool: earned, released,
// and not yet claimed by a payout batch. A row leaves that pool the moment it is
// submitted, so a batch awaiting approval is never double-counted — it is
// reported separately as `awaitingApproval` so the rep can see where the rest of
// their money is.
//
//   commission   positive engine rows (setup fees, bonuses, residuals)
// + salary       salary rows — a base salary is earned money the rep is owed,
//                and it is paid through the same payout workflow
// - deductions   NEGATIVE pending rows. Today those are refund/chargeback
//                clawbacks (see clawbacks.ts), which are booked as negative
//                adjustments precisely so they net off the next payout. Any
//                other recoverable advance entered as a negative line reconciles
//                the same way, with no special case here.
// ---------------
// = available    what a withdrawal may draw on.
//
// `salaryPaidToDate` and `paidToDate` are reported for context, NOT subtracted:
// that money has already left the business, so subtracting it again would charge
// the rep twice for the same payment. The reconciliation rule is simply that
// every dollar appears in exactly one bucket.
//
// Pure: rows in, breakdown out. No database, no clock beyond `asOf`.
// ============================================================================

import type { CommissionStatus } from "../../src/types/index.js";

/** The subset of a ledger row the balance needs. */
export interface BalanceRow {
  id: string;
  commissionAmount: number;
  status: CommissionStatus;
  isProjection: boolean;
  /** 'salary' rows are the base salary; everything else is commission. */
  ruleType: string;
  /** 'engine' | 'clawback' | 'manual'. */
  entrySource?: string | null;
  /** Non-null once a batch has claimed the row. */
  payoutBatchId?: string | null;
  paymentDate?: string;
}

export interface BalanceBreakdown {
  /** Positive commission in the pending pool. */
  commission: number;
  /** Salary rows in the pending pool. */
  salary: number;
  /** Deductions in the pending pool, reported POSITIVE (clawbacks, advances). */
  deductions: number;
  /** commission + salary − deductions, floored at 0. */
  available: number;
  /** Raw net before flooring — negative when the rep owes more than they've earned. */
  net: number;
  /** In a submitted/approved batch: earned, claimed, not yet paid. */
  awaitingApproval: number;
  /** Held or projected — not withdrawable yet. */
  notYetReleased: number;
  /** Already paid out (context only; never subtracted). */
  paidToDate: number;
  /** Of paidToDate, the part that was salary (context only). */
  salaryPaidToDate: number;
  /** Ids that make up `available`, oldest first — what a withdrawal draws on. */
  availableEntryIds: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const isSalaryRow = (r: BalanceRow) => r.ruleType === "salary";

/** Rows sitting in the pending pool: earned, released, unclaimed. */
function isPending(r: BalanceRow): boolean {
  return r.status === "pending" && !r.isProjection;
}

/**
 * Compute a rep's balance from their ledger rows.
 *
 * `rows` must already be scoped to ONE salesperson — this function does no
 * filtering by owner, and mixing two reps would silently produce a wrong number.
 */
export function computeBalance(rows: BalanceRow[]): BalanceBreakdown {
  let commission = 0;
  let salary = 0;
  let deductions = 0;
  let awaitingApproval = 0;
  let notYetReleased = 0;
  let paidToDate = 0;
  let salaryPaidToDate = 0;

  const positives: BalanceRow[] = [];

  for (const r of rows) {
    const amount = Number(r.commissionAmount) || 0;

    if (r.status === "paid") {
      paidToDate += amount;
      if (isSalaryRow(r)) salaryPaidToDate += amount;
      continue;
    }
    if (r.status === "submitted" || r.status === "approved") {
      awaitingApproval += amount;
      continue;
    }
    if (r.status === "held" || (r.status === "projected" && !r.isProjection)) {
      notYetReleased += amount;
      continue;
    }
    if (r.isProjection) {
      // A projection is a forecast of money that has not been earned. It is
      // deliberately NOT part of any balance a rep can draw on.
      notYetReleased += amount;
      continue;
    }
    if (!isPending(r)) continue; // rejected / canceled / clawed_back: settled

    if (amount < 0) {
      deductions += -amount;
      continue;
    }
    if (isSalaryRow(r)) salary += amount;
    else commission += amount;
    positives.push(r);
  }

  const net = commission + salary - deductions;

  // Oldest first: a withdrawal should draw down the money the rep has been
  // waiting on longest, which is also what makes the selection reproducible.
  const availableEntryIds = positives
    .slice()
    .sort((a, b) => (a.paymentDate ?? "").localeCompare(b.paymentDate ?? "") || a.id.localeCompare(b.id))
    .map((r) => r.id);

  return {
    commission: round2(commission),
    salary: round2(salary),
    deductions: round2(deductions),
    available: round2(Math.max(0, net)),
    net: round2(net),
    awaitingApproval: round2(awaitingApproval),
    notYetReleased: round2(notYetReleased),
    paidToDate: round2(paidToDate),
    salaryPaidToDate: round2(salaryPaidToDate),
    availableEntryIds,
  };
}

// ---------------------------------------------------------------------------
// Withdrawal selection
// ---------------------------------------------------------------------------

/** Smallest withdrawal the workflow will accept, so batches stay meaningful. */
export const MIN_WITHDRAWAL = 1;

export type WithdrawalRefusal =
  | "insufficient_balance"
  | "below_minimum"
  | "nothing_to_submit";

export type WithdrawalSelection =
  | { ok: true; entryIds: string[]; amount: number; partial: boolean }
  | { ok: false; error: WithdrawalRefusal };

/**
 * Choose which ledger lines a withdrawal claims.
 *
 * A payout batch is made of WHOLE ledger lines — a line cannot be half-paid
 * without inventing a split that the ledger, the audit trail and the recompute
 * would all then have to model. So a request for less than the full balance
 * takes whole lines oldest-first until it would overshoot, and reports the
 * amount it could actually cover (`partial`). Requesting everything is the
 * common case and always takes the whole pool.
 *
 * DEDUCTIONS ARE NOT OPTIONAL: `available` is already net of them, so a rep
 * carrying a clawback cannot dodge it by withdrawing only their positive lines.
 */
export function selectWithdrawalEntries(
  breakdown: BalanceBreakdown,
  rows: BalanceRow[],
  requestedAmount: number | null,
): WithdrawalSelection {
  if (breakdown.availableEntryIds.length === 0) return { ok: false, error: "nothing_to_submit" };
  if (breakdown.available < MIN_WITHDRAWAL) return { ok: false, error: "insufficient_balance" };

  // null / 0 / anything at-or-above the balance means "all of it".
  const wantsAll = requestedAmount == null || requestedAmount >= breakdown.available;
  if (!wantsAll && requestedAmount < MIN_WITHDRAWAL) return { ok: false, error: "below_minimum" };

  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = breakdown.availableEntryIds
    .map((id) => byId.get(id))
    .filter((r): r is BalanceRow => !!r);

  if (wantsAll) {
    // Everything positive AND every deduction, so the batch total is the true
    // net: a rep drawing their whole balance settles their clawbacks in the
    // same payout rather than leaving them behind.
    const deductionIds = rows
      .filter((r) => isPending(r) && Number(r.commissionAmount) < 0)
      .map((r) => r.id);
    return {
      ok: true,
      entryIds: [...ordered.map((r) => r.id), ...deductionIds],
      amount: breakdown.available,
      partial: false,
    };
  }

  const entryIds: string[] = [];
  let total = 0;
  for (const r of ordered) {
    if (total + r.commissionAmount > requestedAmount) break;
    entryIds.push(r.id);
    total = round2(total + r.commissionAmount);
  }
  if (entryIds.length === 0) {
    // Every available line is individually larger than the request. There is
    // nothing to split, so say so rather than paying more than was asked.
    return { ok: false, error: "below_minimum" };
  }
  return { ok: true, entryIds, amount: round2(total), partial: total < requestedAmount };
}
