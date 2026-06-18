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
