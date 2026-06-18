// ============================================================================
// HANDLER HELPERS  (shared, mostly-pure utilities for per-resource APIs)
//
// Priority-1 work moves write workflows off the snapshot `PUT /api/state` and
// onto real per-resource endpoints (see api/clients.ts for the original
// pattern). To keep every new endpoint consistent — and tenant/role-safe by
// construction — the authorization decisions and input validation live here as
// PURE functions that can be unit-tested with no database (see handlers.test.ts).
//
// The endpoint files stay thin: parse body, check permission, validate input,
// run one tenant-scoped SQL statement.
// ============================================================================

import type { VercelRequest } from "@vercel/node";
import { ADMIN_ROLES, MANAGER_ROLES, SELF_ROLES, type Role } from "./auth.js";

const nowISO = () => new Date().toISOString();

/** Generate a prefixed, collision-resistant id (mirrors api/clients.ts). */
export function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Parse a request body that may arrive as a string or an already-parsed object. */
export function parseBody(req: VercelRequest): Record<string, unknown> {
  const b = req.body;
  if (b == null) return {};
  if (typeof b === "string") {
    try {
      return JSON.parse(b || "{}");
    } catch {
      return {};
    }
  }
  return b as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Authorization (pure)
// ---------------------------------------------------------------------------

/**
 * What a role is allowed to SEE in a people/clients-style listing.
 *   all  -> whole tenant            (owner/admin)
 *   team -> manager's own team      (sales_manager)
 *   self -> only their own record   (salesperson/affiliate/partner)
 */
export type ReadScope = "all" | "team" | "self";

export function readScopeFor(role: Role): ReadScope {
  if (ADMIN_ROLES.includes(role)) return "all";
  if (MANAGER_ROLES.includes(role)) return "team";
  return "self";
}

/** Only owner/admin may create / edit / deactivate people and edit settings. */
export function canManagePeople(role: Role): boolean {
  return ADMIN_ROLES.includes(role);
}

export function canEditSettings(role: Role): boolean {
  return ADMIN_ROLES.includes(role);
}

/** Helper used by tests + endpoints to know if a role is "self-scoped". */
export function isSelfRole(role: Role): boolean {
  return SELF_ROLES.includes(role);
}

// ---------------------------------------------------------------------------
// Salesperson input validation (pure)
// ---------------------------------------------------------------------------

const PERSON_ROLES = ["salesperson", "affiliate", "partner"] as const;
const PERSON_STATUSES = ["active", "inactive"] as const;
const APPROVAL_STATUSES = ["pending", "approved", "rejected"] as const;

export interface SalespersonInsert {
  name: string;
  email: string;
  phone: string;
  role: (typeof PERSON_ROLES)[number];
  referralCode: string;
  status: (typeof PERSON_STATUSES)[number];
  approvalStatus: (typeof APPROVAL_STATUSES)[number];
  source: string;
  commissionPlanId: string | null;
  weeklySalary: number | null;
  salaryStartDate: string | null;
  salaryEndDate: string | null;
  companyName: string | null;
  website: string | null;
  referralSource: string | null;
  notes: string;
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const str = (v: unknown, fallback = ""): string =>
  v == null ? fallback : String(v).trim();

function oneOf<T extends readonly string[]>(
  v: unknown,
  allowed: T,
  fallback: T[number],
): T[number] {
  const s = str(v);
  return (allowed as readonly string[]).includes(s) ? (s as T[number]) : fallback;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Validate + normalize a full salesperson record for INSERT. */
export function normalizeSalespersonInsert(
  body: Record<string, unknown>,
): Result<SalespersonInsert> {
  const name = str(body.name);
  if (!name) return { ok: false, error: "name_required" };

  return {
    ok: true,
    value: {
      name,
      email: str(body.email),
      phone: str(body.phone),
      role: oneOf(body.role, PERSON_ROLES, "salesperson"),
      referralCode: str(body.referralCode),
      status: oneOf(body.status, PERSON_STATUSES, "active"),
      approvalStatus: oneOf(body.approvalStatus, APPROVAL_STATUSES, "approved"),
      source: str(body.source) || "admin",
      commissionPlanId: body.commissionPlanId ? str(body.commissionPlanId) : null,
      weeklySalary: numOrNull(body.weeklySalary),
      salaryStartDate: body.salaryStartDate ? str(body.salaryStartDate) : null,
      salaryEndDate: body.salaryEndDate ? str(body.salaryEndDate) : null,
      companyName: body.companyName ? str(body.companyName) : null,
      website: body.website ? str(body.website) : null,
      referralSource: body.referralSource ? str(body.referralSource) : null,
      notes: str(body.notes),
    },
  };
}

/**
 * Build a PARTIAL update set for PATCH. Only keys actually present in the body
 * are written, each validated. Returns the column→value map (snake_case keys
 * matching the salespeople table) or an error. Empty patch is rejected.
 */
export function buildSalespersonUpdate(
  body: Record<string, unknown>,
): Result<Record<string, unknown>> {
  const set: Record<string, unknown> = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);

  if (has("name")) {
    const name = str(body.name);
    if (!name) return { ok: false, error: "name_required" };
    set.name = name;
  }
  if (has("email")) set.email = str(body.email);
  if (has("phone")) set.phone = str(body.phone);
  if (has("role")) set.role = oneOf(body.role, PERSON_ROLES, "salesperson");
  if (has("referralCode")) set.referral_code = str(body.referralCode);
  if (has("status")) set.status = oneOf(body.status, PERSON_STATUSES, "active");
  if (has("approvalStatus"))
    set.approval_status = oneOf(body.approvalStatus, APPROVAL_STATUSES, "approved");
  if (has("commissionPlanId"))
    set.commission_plan_id = body.commissionPlanId ? str(body.commissionPlanId) : null;
  if (has("weeklySalary")) set.weekly_salary = numOrNull(body.weeklySalary);
  if (has("salaryStartDate"))
    set.salary_start_date = body.salaryStartDate ? str(body.salaryStartDate) : null;
  if (has("salaryEndDate"))
    set.salary_end_date = body.salaryEndDate ? str(body.salaryEndDate) : null;
  if (has("companyName")) set.company_name = body.companyName ? str(body.companyName) : null;
  if (has("website")) set.website = body.website ? str(body.website) : null;
  if (has("referralSource"))
    set.referral_source = body.referralSource ? str(body.referralSource) : null;
  if (has("notes")) set.notes = str(body.notes);

  if (Object.keys(set).length === 0) return { ok: false, error: "no_fields_to_update" };
  set.updated_at = nowISO();
  return { ok: true, value: set };
}

// ---------------------------------------------------------------------------
// Settings input validation (pure)
// ---------------------------------------------------------------------------

export interface SettingsInput {
  companyName: string;
  theme: "light" | "dark";
  defaultSetupFee: number;
  defaultMonthly: number;
  closingsPerMonth: number;
  churnPct: number;
  months: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const nonNeg = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** Validate + normalize settings (from either flat fields or {assumptions}). */
export function normalizeSettingsInput(body: Record<string, unknown>): Result<SettingsInput> {
  const a = (body.assumptions ?? {}) as Record<string, unknown>;
  const pick = (flat: string, nested: string, fallback = 0) =>
    nonNeg(body[flat] ?? a[nested], fallback);

  const churnRaw = Number(body.monthlyChurnPct ?? a.monthlyChurnPct ?? 0);
  const monthsRaw = Number(body.months ?? a.months ?? 60);

  return {
    ok: true,
    value: {
      companyName: str(body.companyName),
      theme: oneOf(body.theme, ["light", "dark"] as const, "light"),
      defaultSetupFee: pick("avgSetupFee", "avgSetupFee", 0),
      defaultMonthly: pick("avgMonthly", "avgMonthly", 0),
      closingsPerMonth: pick("closingsPerMonth", "closingsPerMonth", 0),
      churnPct: Number.isFinite(churnRaw) ? clamp(churnRaw, 0, 100) : 0,
      months: Number.isFinite(monthsRaw) ? clamp(Math.round(monthsRaw), 1, 600) : 60,
    },
  };
}

// ===========================================================================
// Goals + milestones (pure validation)  — used by /api/goals
//
// A goal targets a metric for a salesperson, a manager's team, or the tenant,
// over a period. Only owner/admin/sales_manager manage them; the endpoint adds
// the scope guards (a manager may only target their own team/reps). Progress is
// computed elsewhere (src/lib/goals.ts) from real data — never trusted/stored.
// ===========================================================================

import type { GoalMetric, GoalScopeType, GoalPeriod } from "../../src/types/index.js";

const GOAL_METRICS = ["revenue", "clients_closed", "referrals", "mrr", "commission_earned", "activity"] as const;
const GOAL_SCOPES = ["salesperson", "team", "tenant"] as const;
const GOAL_PERIODS = ["monthly", "quarterly", "custom"] as const;

export function canManageGoals(role: Role): boolean {
  return ADMIN_ROLES.includes(role) || MANAGER_ROLES.includes(role);
}

export interface GoalInput {
  scopeType: GoalScopeType;
  salespersonId: string | null;
  managerUserId: string | null;
  metric: GoalMetric;
  title: string;
  targetValue: number;
  period: GoalPeriod;
  periodStart: string | null;
  periodEnd: string | null;
}

/** Validate + normalize a goal for create/update (scope guards live in the endpoint). */
export function normalizeGoalInput(body: Record<string, unknown>): Result<GoalInput> {
  const scopeType = oneOf(body.scopeType, GOAL_SCOPES, "salesperson");
  const targetValue = nonNeg(body.targetValue, 0);
  if (targetValue <= 0) return { ok: false, error: "target_required" };

  const salespersonId = scopeType === "salesperson" && body.salespersonId ? str(body.salespersonId) : "";
  if (scopeType === "salesperson" && !salespersonId) return { ok: false, error: "salesperson_required" };

  return {
    ok: true,
    value: {
      scopeType,
      salespersonId: salespersonId || null,
      managerUserId: scopeType === "team" && body.managerUserId ? str(body.managerUserId) : null,
      metric: oneOf(body.metric, GOAL_METRICS, "revenue") as GoalMetric,
      title: str(body.title),
      targetValue,
      period: oneOf(body.period, GOAL_PERIODS, "monthly") as GoalPeriod,
      periodStart: body.periodStart ? str(body.periodStart) : null,
      periodEnd: body.periodEnd ? str(body.periodEnd) : null,
    },
  };
}

export interface MilestoneInput {
  goalId: string;
  title: string;
  thresholdValue: number;
  reward: string;
}

/** Validate + normalize a milestone for INSERT (goalId + positive threshold). */
export function normalizeMilestoneInput(body: Record<string, unknown>): Result<MilestoneInput> {
  const goalId = str(body.goalId);
  if (!goalId) return { ok: false, error: "goal_id_required" };
  const thresholdValue = nonNeg(body.thresholdValue, 0);
  if (thresholdValue <= 0) return { ok: false, error: "threshold_required" };
  return { ok: true, value: { goalId, title: str(body.title), thresholdValue, reward: str(body.reward) } };
}

// ===========================================================================
// Tenant feature access (pure)  — used by /api/features
//
// The agency/owner controls which product areas a tenant (sub-account) may use.
// Flags are stored as OVERRIDES in tenant_feature_access; ABSENCE OF A ROW means
// the feature is ENABLED (features are on by default, so a brand-new tenant has
// the full product). Only owner/admin may change them. The validation here is
// PURE and DB-free so it can be unit-tested (see handlers.test.ts). The route
// guard + nav on the client mirror this list in src/lib/features.ts.
// ===========================================================================

/** Canonical product areas an agency can toggle per tenant. KEEP IN SYNC with
 *  FEATURES in src/lib/features.ts on the client. */
export const FEATURE_KEYS = [
  "commissions",
  "sales_portal",
  "affiliate_portal",
  "proposals",
  "contracts",
  "ai",
  "payouts",
  "reports",
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];
export type FeatureFlags = Record<FeatureKey, boolean>;

const FEATURE_KEY_SET = new Set<string>(FEATURE_KEYS);

/** Every feature enabled — the default for a tenant with no override rows. */
export function defaultFeatureFlags(): FeatureFlags {
  const out = {} as FeatureFlags;
  for (const k of FEATURE_KEYS) out[k] = true;
  return out;
}

/** Build the effective flag map from stored override rows (default = enabled). */
export function mergeFeatureRows(
  rows: Array<{ feature: string; enabled: boolean | null }>,
): FeatureFlags {
  const out = defaultFeatureFlags();
  for (const r of rows) {
    if (FEATURE_KEY_SET.has(r.feature)) out[r.feature as FeatureKey] = !!r.enabled;
  }
  return out;
}

/** Only owner/admin may change feature access (agency-level control). */
export function canManageFeatures(role: Role): boolean {
  return ADMIN_ROLES.includes(role);
}

function toBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = String(v).trim().toLowerCase();
  return !["0", "false", "off", "no", "disabled", ""].includes(s);
}

/**
 * Validate a feature-flag PUT/PATCH body into a partial map of KNOWN features
 * only (unknown keys are ignored, never trusted). Accepts a flat body
 * `{ commissions: false }` or a wrapped one `{ features: { … } }`. An empty
 * patch (no recognised feature keys) is rejected.
 */
export function normalizeFeatureFlags(
  body: Record<string, unknown>,
): Result<Partial<FeatureFlags>> {
  const src =
    body.features && typeof body.features === "object"
      ? (body.features as Record<string, unknown>)
      : body;
  const out: Partial<FeatureFlags> = {};
  for (const k of FEATURE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = toBool(src[k]);
  }
  if (Object.keys(out).length === 0) return { ok: false, error: "no_known_features" };
  return { ok: true, value: out };
}
