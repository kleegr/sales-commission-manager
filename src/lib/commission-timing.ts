// ============================================================================
// COMMISSION TIMING  (hold / release / clawback)
//
// Pure, deterministic logic that decides, for a single earned commission,
// WHETHER it is payable yet and WHY. Given the same inputs you always get the
// same result — exactly what a commission system needs. There is NO database
// access and NO randomness here.
//
// A plan carries a `CommissionTiming`. Every commission that plan's rules
// generate is run through resolveCommissionTiming() to land on one of three
// timing states:
//
//   held        -> earned but not yet releasable (waiting on time / payments /
//                  approval, or the client is not active)
//   pending      -> earned AND released — ready to enter the payout workflow
//   clawed_back  -> the client canceled/refunded inside the clawback window
//
// The eight behaviours the product promises map onto the fields like this:
//   Pay immediately .............. trigger=immediate
//   Pay after X days ............. trigger=after_days,           days=X
//   Pay after X months ........... trigger=after_months,         months=X
//   Pay after X payments ......... trigger=after_payments,       payments=X
//   Hold until approval .......... trigger=on_approval
//   Release after refund window .. trigger=after_refund_window,  days=X
//   Pay only if still active ..... requireActiveClient=true
//   Claw back if cancels early ... clawbackBeforeMonths=X
// ============================================================================

import type {
  ClientStatus,
  CommissionReleaseTrigger,
  CommissionTiming,
} from "../types/index.js";
import { addDaysISO, addMonthsISO, daysBetween, isoToDate, monthsBetween } from "./format.js";

/** Pay-immediately, no conditions. Preserves the app's historical behaviour. */
export const DEFAULT_TIMING: CommissionTiming = {
  trigger: "immediate",
  days: 0,
  months: 0,
  payments: 0,
  requireActiveClient: false,
  clawbackBeforeMonths: 0,
};

/** Coerce a partial / legacy / persisted-json timing object into a full one. */
export function normalizeTiming(
  t?: Partial<CommissionTiming> | null,
): CommissionTiming {
  if (!t) return { ...DEFAULT_TIMING };
  const n = (v: unknown) => {
    const x = Math.floor(Number(v));
    return Number.isFinite(x) && x > 0 ? x : 0;
  };
  const trigger: CommissionReleaseTrigger =
    t.trigger && TRIGGERS.includes(t.trigger) ? t.trigger : "immediate";
  return {
    trigger,
    days: n(t.days),
    months: n(t.months),
    payments: n(t.payments),
    requireActiveClient: Boolean(t.requireActiveClient),
    clawbackBeforeMonths: n(t.clawbackBeforeMonths),
  };
}

export const TRIGGERS: CommissionReleaseTrigger[] = [
  "immediate",
  "after_days",
  "after_months",
  "after_payments",
  "on_approval",
  "after_refund_window",
];

export const TRIGGER_LABEL: Record<CommissionReleaseTrigger, string> = {
  immediate: "Pay immediately",
  after_days: "Pay after a number of days",
  after_months: "Pay after a number of months",
  after_payments: "Pay after a number of payments",
  on_approval: "Hold until approved",
  after_refund_window: "Release after a refund window",
};

/** One-line human summary of a timing config, for plan cards / the builder. */
export function timingHeadline(input?: CommissionTiming | null): string {
  const t = normalizeTiming(input);
  let base: string;
  switch (t.trigger) {
    case "immediate":
      base = "Pays immediately";
      break;
    case "after_days":
      base = `Pays ${t.days} day${t.days === 1 ? "" : "s"} after earned`;
      break;
    case "after_months":
      base = `Pays ${t.months} month${t.months === 1 ? "" : "s"} after earned`;
      break;
    case "after_payments":
      base = `Pays after ${t.payments} client payment${t.payments === 1 ? "" : "s"}`;
      break;
    case "on_approval":
      base = "Held until approved";
      break;
    case "after_refund_window":
      base = `Held through a ${t.days}-day refund window`;
      break;
  }
  const extras: string[] = [];
  if (t.requireActiveClient) extras.push("active clients only");
  if (t.clawbackBeforeMonths > 0)
    extras.push(`clawback under ${t.clawbackBeforeMonths} mo`);
  return extras.length ? `${base} · ${extras.join(" · ")}` : base;
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export interface TimingContext {
  timing: CommissionTiming;
  /** When the commission was earned (normally the payment date), ISO. */
  earnedDate: string;
  /** Evaluation date ("today"), ISO. */
  asOf: string;
  clientStatus?: ClientStatus | null;
  clientSignupDate?: string | null;
  /** When the client canceled/refunded, ISO; falls back to asOf if unknown. */
  clientCanceledDate?: string | null;
  /** Count of the client's qualifying payments at/under asOf (after_payments). */
  clientPaymentCount?: number;
  /** Admin force-release: bypass the trigger / active condition (not clawback). */
  releasedOverride?: boolean;
}

export type TimingStatus = "held" | "pending" | "clawed_back";

export interface TimingResult {
  status: TimingStatus; // "pending" == released & payable
  released: boolean;
  earnedDate: string;
  releaseDate: string | null; // null when there is no fixed date (payments/approval)
  holdDays: number | null; // hold length in days, when date-based
  reason: string; // hold / pending reason (empty once released)
  clawbackReason: string | null;
  trigger: CommissionReleaseTrigger;
}

const isInactive = (s?: ClientStatus | null) => s != null && s !== "active";

export function resolveCommissionTiming(ctx: TimingContext): TimingResult {
  const timing = normalizeTiming(ctx.timing);
  const { earnedDate, asOf } = ctx;
  const status = ctx.clientStatus ?? "active";

  const base = {
    earnedDate,
    releaseDate: null as string | null,
    holdDays: null as number | null,
    trigger: timing.trigger,
  };

  // 1) Clawback wins over everything. If the client canceled/refunded inside the
  //    window (measured signup -> cancel date), the commission is reversed.
  if (
    timing.clawbackBeforeMonths > 0 &&
    (status === "canceled" || status === "refunded")
  ) {
    const signup = ctx.clientSignupDate || earnedDate;
    const canceledOn = ctx.clientCanceledDate || asOf;
    const monthsActive = Math.max(0, monthsBetween(signup, canceledOn));
    if (monthsActive < timing.clawbackBeforeMonths) {
      return {
        ...base,
        status: "clawed_back",
        released: false,
        reason: "",
        clawbackReason: `Client canceled at month ${monthsActive} — inside the ${timing.clawbackBeforeMonths}-month clawback window`,
      };
    }
  }

  // 2) Admin force-release bypasses the trigger and the active-client condition.
  if (ctx.releasedOverride) {
    return {
      ...base,
      releaseDate: asOf,
      holdDays: 0,
      status: "pending",
      released: true,
      reason: "",
      clawbackReason: null,
    };
  }

  // 3) Trigger gating -> a release date and whether it has been reached.
  let releaseDate: string | null = null;
  let holdDays: number | null = null;
  let released = true;
  let waiting = "";

  switch (timing.trigger) {
    case "immediate":
      releaseDate = earnedDate;
      holdDays = 0;
      released = true;
      break;
    case "after_days":
      releaseDate = addDaysISO(earnedDate, timing.days);
      holdDays = timing.days;
      released = daysBetween(asOf, releaseDate) <= 0; // asOf >= releaseDate
      waiting = `Releases ${timing.days} day${timing.days === 1 ? "" : "s"} after earned, on ${releaseDate}`;
      break;
    case "after_refund_window":
      releaseDate = addDaysISO(earnedDate, timing.days);
      holdDays = timing.days;
      released = daysBetween(asOf, releaseDate) <= 0;
      waiting = `Refund window ${timing.days} day${timing.days === 1 ? "" : "s"} — releases ${releaseDate}`;
      break;
    case "after_months":
      releaseDate = addMonthsISO(earnedDate, timing.months);
      holdDays = daysBetween(earnedDate, releaseDate);
      released = daysBetween(asOf, releaseDate) <= 0;
      waiting = `Releases ${timing.months} month${timing.months === 1 ? "" : "s"} after earned, on ${releaseDate}`;
      break;
    case "after_payments": {
      const have = Math.max(0, ctx.clientPaymentCount ?? 0);
      released = have >= timing.payments;
      waiting = `Pays after ${timing.payments} payment${timing.payments === 1 ? "" : "s"} (${Math.min(have, timing.payments)}/${timing.payments})`;
      break;
    }
    case "on_approval":
      released = false; // manual gate; only an admin release moves it on
      waiting = "Held until approved";
      break;
  }

  // 4) Active-client condition: never release onto an inactive client.
  if (timing.requireActiveClient && isInactive(status)) {
    return {
      ...base,
      releaseDate,
      holdDays,
      status: "held",
      released: false,
      reason: `Held — client is ${status}; pays only while active`,
      clawbackReason: null,
    };
  }

  if (!released) {
    return {
      ...base,
      releaseDate,
      holdDays,
      status: "held",
      released: false,
      reason: waiting,
      clawbackReason: null,
    };
  }

  return {
    ...base,
    releaseDate,
    holdDays,
    status: "pending",
    released: true,
    reason: "",
    clawbackReason: null,
  };
}

/** True when the persisted/derived status represents a still-held line. */
export function isHeld(status: string): boolean {
  return status === "held";
}

/** Convenience: a stable sort key for "what date governs this line". */
export function effectiveDate(
  releaseDate: string | null,
  dueDate: string,
): string {
  if (!releaseDate) return dueDate;
  return isoToDate(releaseDate).getTime() >= isoToDate(dueDate).getTime()
    ? releaseDate
    : dueDate;
}
