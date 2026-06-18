// ============================================================================
// COMMISSION HANDLER HELPERS  (pure validation + authorization)
//
// Mirrors the pattern in handlers.ts: the authorization decisions and input
// validation for the Commission Plans, Payments and Ledger endpoints live here
// as PURE, database-free functions so they can be unit-tested with no DB (see
// commission-handlers.test.ts). The endpoint files stay thin: parse body, check
// permission, validate, run tenant-scoped SQL, recompute.
//
// Kept in a separate module (not handlers.ts) so this slice is additive.
// ============================================================================

import { ADMIN_ROLES, MANAGER_ROLES, SELF_ROLES, type Role } from "./auth.js";
import { normalizeTiming } from "../../src/lib/commission-timing.js";
import type {
  CommissionStatus,
  CommissionTiming,
  PaymentType,
  Rule,
  RuleType,
  SetupFeeMode,
  ValueType,
} from "../../src/types/index.js";

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const nowISO = () => new Date().toISOString();

/** Prefixed, collision-resistant id (mirrors handlers.ts / clients.ts). */
export function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const str = (v: unknown, fallback = ""): string =>
  v == null ? fallback : String(v).trim();

function oneOf<T extends readonly string[]>(v: unknown, allowed: T, fallback: T[number]): T[number] {
  const s = str(v);
  return (allowed as readonly string[]).includes(s) ? (s as T[number]) : fallback;
}

const num = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const nonNeg = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
const intOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : null;
};
const boolOf = (v: unknown): boolean => v === true || v === "true" || v === 1 || v === "1";

// ---------------------------------------------------------------------------
// Authorization (pure)
// ---------------------------------------------------------------------------

/** Only owner/admin may create/edit/delete/duplicate/reorder commission plans. */
export function canManagePlans(role: Role): boolean {
  return ADMIN_ROLES.includes(role);
}

/** Owner/admin/manager/self may record payments (each call is scope-checked
 *  against the payment's client, exactly like api/clients.ts). */
export function canManagePayments(role: Role): boolean {
  return (
    ADMIN_ROLES.includes(role) ||
    MANAGER_ROLES.includes(role) ||
    SELF_ROLES.includes(role)
  );
}

/** Only owner/admin may release a held commission or force a ledger recompute. */
export function canReleaseCommission(role: Role): boolean {
  return ADMIN_ROLES.includes(role);
}
export function canRecomputeLedger(role: Role): boolean {
  return ADMIN_ROLES.includes(role);
}

/** Read scope for payments/ledger listings: all | team | self. */
export type ReadScope = "all" | "team" | "self";
export function commissionReadScope(role: Role): ReadScope {
  if (ADMIN_ROLES.includes(role)) return "all";
  if (MANAGER_ROLES.includes(role)) return "team";
  return "self";
}

// ---------------------------------------------------------------------------
// Commission rule validation (pure)  — covers all four rule types, which is how
// "save setup-fee / signup-bonus / monthly-residual / salary rules" are stored.
// ---------------------------------------------------------------------------

const RULE_TYPES = ["setup_fee", "signup_bonus", "monthly_residual", "salary"] as const;
const SETUP_MODES = ["none", "percentage", "fixed"] as const;
const VALUE_TYPES = ["percentage", "fixed"] as const;

/** Validate + normalize a single rule of any type, assigning an id if missing. */
export function normalizeRule(raw: unknown): Result<Rule> {
  if (!raw || typeof raw !== "object") return { ok: false, error: "invalid_rule" };
  const r = raw as Record<string, unknown>;
  const type = str(r.type) as RuleType;
  if (!(RULE_TYPES as readonly string[]).includes(type)) {
    return { ok: false, error: "invalid_rule_type" };
  }
  const id = r.id ? str(r.id) : uid("rule");

  switch (type) {
    case "setup_fee": {
      const mode = oneOf(r.mode, SETUP_MODES, "none") as SetupFeeMode;
      return { ok: true, value: { id, type: "setup_fee", mode, value: nonNeg(r.value, 0) } };
    }
    case "signup_bonus":
      return { ok: true, value: { id, type: "signup_bonus", amount: nonNeg(r.amount, 0) } };
    case "monthly_residual": {
      const startMonth = Math.max(1, intOrNull(r.startMonth) ?? 1);
      const continueForever = boolOf(r.continueForever);
      let endMonth = intOrNull(r.endMonth);
      if (continueForever) endMonth = null;
      else if (endMonth != null && endMonth < startMonth) endMonth = startMonth;
      return {
        ok: true,
        value: {
          id,
          type: "monthly_residual",
          startMonth,
          endMonth,
          continueForever,
          valueType: oneOf(r.valueType, VALUE_TYPES, "percentage") as ValueType,
          value: nonNeg(r.value, 0),
        },
      };
    }
    case "salary":
      return {
        ok: true,
        value: {
          id,
          type: "salary",
          weeklyAmount: nonNeg(r.weeklyAmount, 0),
          startDate: r.startDate ? str(r.startDate) : null,
          endDate: r.endDate ? str(r.endDate) : null,
          maxWeeks: intOrNull(r.maxWeeks),
        },
      };
  }
}

/** Validate + normalize an ordered array of rules. */
export function normalizeRules(raw: unknown): Result<Rule[]> {
  if (raw == null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "rules_must_be_array" };
  const out: Rule[] = [];
  for (const item of raw) {
    const res = normalizeRule(item);
    if (!res.ok) return res;
    out.push(res.value);
  }
  return { ok: true, value: out };
}

// ---------------------------------------------------------------------------
// Commission plan validation (pure)
// ---------------------------------------------------------------------------

export interface PlanInput {
  name: string;
  description: string;
  sampleSetupFee: number;
  sampleMonthly: number;
  /** undefined when the timing is the plain pay-immediately default. */
  timing: CommissionTiming | undefined;
  /** Present only when the caller supplied a rules array. */
  rules?: Rule[];
}

/** Coerce a timing patch to a full timing, or undefined when it is the default. */
export function normalizePlanTiming(raw: unknown): CommissionTiming | undefined {
  if (raw == null) return undefined;
  const t = normalizeTiming(raw as Partial<CommissionTiming>);
  const isDefault =
    t.trigger === "immediate" && !t.requireActiveClient && t.clawbackBeforeMonths === 0;
  return isDefault ? undefined : t;
}

/**
 * Validate + normalize a plan for create/replace. `rules` is included only when
 * provided so a metadata-only PATCH-style replace can omit it. An empty name
 * defaults to "Untitled plan" to match the builder UI.
 */
export function normalizePlanInput(
  body: Record<string, unknown>,
  opts: { requireRules?: boolean } = {},
): Result<PlanInput> {
  const name = str(body.name) || "Untitled plan";

  let rules: Rule[] | undefined;
  if (opts.requireRules || "rules" in body) {
    const r = normalizeRules(body.rules);
    if (!r.ok) return r;
    rules = r.value;
  }

  return {
    ok: true,
    value: {
      name,
      description: str(body.description),
      sampleSetupFee: nonNeg(body.sampleSetupFee, 0),
      sampleMonthly: nonNeg(body.sampleMonthly, 0),
      timing: normalizePlanTiming(body.timing),
      ...(rules !== undefined ? { rules } : {}),
    },
  };
}

/** Validate a reorder request: a non-empty array of plan ids. */
export function normalizeOrderedIds(body: Record<string, unknown>): Result<string[]> {
  const raw = (body.orderedIds ?? body.ids) as unknown;
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "ordered_ids_required" };
  const ids = raw.map((x) => str(x)).filter(Boolean);
  if (ids.length === 0) return { ok: false, error: "ordered_ids_required" };
  return { ok: true, value: ids };
}

// ---------------------------------------------------------------------------
// Payment validation (pure)
// ---------------------------------------------------------------------------

const PAYMENT_TYPES = ["setup_fee", "monthly_subscription", "refund", "adjustment"] as const;

export interface PaymentInput {
  clientId: string;
  date: string;
  type: PaymentType;
  amount: number;
  paymentNumber: number | null;
  notes: string;
}

/** Validate + normalize a payment for INSERT. */
export function normalizePaymentInput(body: Record<string, unknown>): Result<PaymentInput> {
  const clientId = str(body.clientId);
  if (!clientId) return { ok: false, error: "client_required" };

  const type = oneOf(body.type, PAYMENT_TYPES, "monthly_subscription") as PaymentType;
  const amount = nonNeg(body.amount, 0);

  // Payment number is meaningful only for monthly subscriptions.
  let paymentNumber: number | null = null;
  if (type === "monthly_subscription") {
    paymentNumber = Math.max(1, intOrNull(body.paymentNumber) ?? 1);
  }

  return {
    ok: true,
    value: {
      clientId,
      date: str(body.date) || nowISO().slice(0, 10),
      type,
      amount,
      paymentNumber,
      notes: str(body.notes),
    },
  };
}

/**
 * Build a PARTIAL update set for a payment PATCH (snake_case columns). Only keys
 * present in the body are written. `commissionAffecting` lists which of those
 * keys would change the generated commissions (so the endpoint can refuse the
 * edit when the payment has locked commissions). Empty patch is rejected.
 */
export function buildPaymentUpdate(
  body: Record<string, unknown>,
): Result<{ set: Record<string, unknown>; commissionAffecting: string[] }> {
  const set: Record<string, unknown> = {};
  const commissionAffecting: string[] = [];
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);

  if (has("clientId")) {
    const v = str(body.clientId);
    if (!v) return { ok: false, error: "client_required" };
    set.client_id = v;
    commissionAffecting.push("client_id");
  }
  if (has("date")) {
    set.payment_date = str(body.date);
    commissionAffecting.push("payment_date");
  }
  if (has("type")) {
    set.payment_type = oneOf(body.type, PAYMENT_TYPES, "monthly_subscription");
    commissionAffecting.push("payment_type");
  }
  if (has("amount")) {
    set.amount = nonNeg(body.amount, 0);
    commissionAffecting.push("amount");
  }
  if (has("paymentNumber")) {
    set.payment_number = intOrNull(body.paymentNumber);
    commissionAffecting.push("payment_number");
  }
  if (has("notes")) set.notes = str(body.notes); // notes never affect commissions

  if (Object.keys(set).length === 0) return { ok: false, error: "no_fields_to_update" };
  set.updated_at = nowISO();
  return { ok: true, value: { set, commissionAffecting } };
}

// ---------------------------------------------------------------------------
// Ledger filters (pure)
// ---------------------------------------------------------------------------

const LEDGER_STATUSES = [
  "projected",
  "held",
  "pending",
  "submitted",
  "approved",
  "paid",
  "rejected",
  "canceled",
  "clawed_back",
] as const;

export interface LedgerFilters {
  salespersonId: string | null;
  clientId: string | null;
  status: CommissionStatus | null;
  from: string | null;
  to: string | null;
}

/** Parse + validate ledger list filters from a query object. */
export function parseLedgerFilters(q: Record<string, unknown>): LedgerFilters {
  const status = str(q.status);
  return {
    salespersonId: q.salespersonId ? str(q.salespersonId) : null,
    clientId: q.clientId ? str(q.clientId) : null,
    status: (LEDGER_STATUSES as readonly string[]).includes(status)
      ? (status as CommissionStatus)
      : null,
    from: q.from ? str(q.from) : null,
    to: q.to ? str(q.to) : null,
  };
}

/** Validate a list of commission-entry ids (for the release action). */
export function normalizeIdList(body: Record<string, unknown>): Result<string[]> {
  const raw = (body.ids ?? body.commissionEntryIds) as unknown;
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "ids_required" };
  const ids = raw.map((x) => str(x)).filter(Boolean);
  if (ids.length === 0) return { ok: false, error: "ids_required" };
  return { ok: true, value: ids };
}
