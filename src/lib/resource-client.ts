// ============================================================================
// RESOURCE CLIENT  (front-end calls to the per-resource DB APIs)
//
// Thin fetch wrappers around /api/salespeople and /api/settings (the real
// per-resource endpoints that replace the salespeople/settings portions of the
// snapshot PUT /api/state). Each throws on a non-2xx response so callers can
// fall back to the local store when the API isn't reachable (e.g. `vite dev`
// with no serverless functions, or the local-storage fallback backend).
//
// The tenant + role are derived from the session cookie on the server; the
// client never sends them.
// ============================================================================

import type { ProjectionAssumptions, Salesperson } from "../types";

async function asJson(res: Response): Promise<any> {
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) throw new Error(`non_json_response_${res.status}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || `request_failed_${res.status}`);
  return body;
}

// ---- Salespeople -----------------------------------------------------------

/** Fields the create/update endpoints accept (server ignores the rest). */
export type SalespersonInput = Partial<
  Pick<
    Salesperson,
    | "name"
    | "email"
    | "phone"
    | "role"
    | "referralCode"
    | "status"
    | "approvalStatus"
    | "commissionPlanId"
    | "weeklySalary"
    | "salaryStartDate"
    | "salaryEndDate"
    | "notes"
  >
>;

export async function createSalesperson(input: SalespersonInput): Promise<{ id: string }> {
  const res = await fetch("/api/salespeople", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return asJson(res);
}

export async function updateSalesperson(id: string, input: SalespersonInput): Promise<void> {
  const res = await fetch(`/api/salespeople?id=${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  await asJson(res);
}

/** Soft delete (status -> inactive). Reversible by editing the person. */
export async function deactivateSalesperson(id: string): Promise<void> {
  const res = await fetch(`/api/salespeople?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  await asJson(res);
}

/** Approve/reject a pending affiliate application. */
export async function setSalespersonApproval(
  id: string,
  approval: "approved" | "rejected",
): Promise<void> {
  await updateSalesperson(id, {
    approvalStatus: approval,
    status: approval === "approved" ? "active" : "inactive",
  });
}

// ---- Settings --------------------------------------------------------------

export interface SettingsPayload {
  companyName: string;
  theme: "light" | "dark";
  assumptions: ProjectionAssumptions;
}

export async function saveSettings(payload: SettingsPayload): Promise<void> {
  const res = await fetch("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      companyName: payload.companyName,
      theme: payload.theme,
      assumptions: payload.assumptions,
    }),
  });
  await asJson(res);
}

// ---- Goals & milestones ----------------------------------------------------
// Server-owned; fetched directly (not part of AppData). Tenant + role come from
// the session. Each goal in the response carries a server-computed `actual`.

import type { Goal, GoalMetric, GoalPeriod, GoalScopeType, Milestone } from "../types";

export interface GoalsResponse {
  goals: Goal[];
  milestones: Milestone[];
}

export async function listGoals(): Promise<GoalsResponse> {
  const res = await fetch("/api/goals", { headers: { "content-type": "application/json" } });
  return asJson(res);
}

export interface GoalInput {
  scopeType: GoalScopeType;
  salespersonId?: string | null;
  managerUserId?: string | null;
  metric: GoalMetric;
  title: string;
  targetValue: number;
  period: GoalPeriod;
  periodStart?: string | null;
  periodEnd?: string | null;
}

export async function createGoal(input: GoalInput): Promise<{ id: string }> {
  const res = await fetch("/api/goals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return asJson(res);
}

export async function updateGoal(id: string, input: GoalInput): Promise<void> {
  const res = await fetch(`/api/goals?id=${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  await asJson(res);
}

export async function deleteGoal(id: string): Promise<void> {
  const res = await fetch(`/api/goals?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  await asJson(res);
}

export interface MilestoneInput {
  goalId: string;
  title: string;
  thresholdValue: number;
  reward: string;
}

export async function createMilestone(input: MilestoneInput): Promise<{ id: string }> {
  const res = await fetch("/api/goals?resource=milestone", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return asJson(res);
}

export async function deleteMilestone(id: string): Promise<void> {
  const res = await fetch(`/api/goals?resource=milestone&id=${encodeURIComponent(id)}`, { method: "DELETE" });
  await asJson(res);
}

// ---- Feature access --------------------------------------------------------
// Server-owned, tenant-scoped feature flags (agency/owner control). The tenant
// comes from the session. GET returns the full map; PUT (owner/admin) writes
// overrides and returns the updated map.

import type { FeatureFlags } from "./features";

export async function getFeatures(): Promise<Partial<FeatureFlags>> {
  const res = await fetch("/api/features", { headers: { accept: "application/json" } });
  const body = await asJson(res);
  return (body?.features ?? {}) as Partial<FeatureFlags>;
}

export async function saveFeatures(patch: Partial<FeatureFlags>): Promise<FeatureFlags> {
  const res = await fetch("/api/features", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ features: patch }),
  });
  const body = await asJson(res);
  return body.features as FeatureFlags;
}

// ===========================================================================
// Commission Plans + Payments + Ledger  (real DB APIs; replace snapshot saving)
//
// The tenant + role come from the session on the server. Each call throws on a
// non-2xx response (asJson) so the page can fall back to the local store in
// dev / local-storage mode, and so a guarded error like
// "has_locked_commissions" surfaces as the thrown Error's message.
// ===========================================================================

import type { CommissionEntry, CommissionPlan, Payment } from "../types";

// ---- Commission plans ------------------------------------------------------

/** The fields the plan create/replace endpoints accept. */
export type PlanPayload = Pick<
  CommissionPlan,
  "name" | "description" | "sampleSetupFee" | "sampleMonthly" | "timing" | "rules"
>;

export async function listPlans(): Promise<CommissionPlan[]> {
  const res = await fetch("/api/plans", { headers: { accept: "application/json" } });
  const body = await asJson(res);
  return (body.plans ?? []) as CommissionPlan[];
}

export async function createPlan(payload: PlanPayload): Promise<{ id: string }> {
  const res = await fetch("/api/plans", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return asJson(res);
}

export async function updatePlan(id: string, payload: PlanPayload): Promise<void> {
  const res = await fetch(`/api/plans?id=${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  await asJson(res);
}

export async function duplicatePlan(id: string): Promise<{ id: string }> {
  const res = await fetch(`/api/plans?action=duplicate&id=${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  return asJson(res);
}

export async function reorderPlans(orderedIds: string[]): Promise<void> {
  const res = await fetch("/api/plans?action=reorder", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ orderedIds }),
  });
  await asJson(res);
}

/** Hard delete (unassigns salespeople + recomputes). Pass deactivate to soft-disable. */
export async function deletePlan(id: string, opts: { deactivate?: boolean } = {}): Promise<void> {
  const q = opts.deactivate ? `&deactivate=1` : "";
  const res = await fetch(`/api/plans?id=${encodeURIComponent(id)}${q}`, { method: "DELETE" });
  await asJson(res);
}

// ---- Payments --------------------------------------------------------------

export type PaymentPayload = Pick<
  Payment,
  "clientId" | "date" | "type" | "amount" | "paymentNumber" | "notes"
>;

export async function listPayments(): Promise<Payment[]> {
  const res = await fetch("/api/payments", { headers: { accept: "application/json" } });
  const body = await asJson(res);
  return (body.payments ?? []) as Payment[];
}

export async function createPayment(payload: PaymentPayload): Promise<{ id: string }> {
  const res = await fetch("/api/payments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return asJson(res);
}

export async function updatePayment(id: string, payload: Partial<PaymentPayload>): Promise<void> {
  const res = await fetch(`/api/payments?id=${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  await asJson(res);
}

/** Delete a payment. Throws Error("has_locked_commissions") if it is locked. */
export async function deletePayment(id: string): Promise<void> {
  const res = await fetch(`/api/payments?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  await asJson(res);
}

// ---- Ledger ----------------------------------------------------------------

export interface LedgerQuery {
  salespersonId?: string;
  clientId?: string;
  status?: string;
  from?: string;
  to?: string;
}

export async function listLedger(q: LedgerQuery = {}): Promise<CommissionEntry[]> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v) params.set(k, String(v));
  const qs = params.toString();
  const res = await fetch(`/api/ledger${qs ? `?${qs}` : ""}`, { headers: { accept: "application/json" } });
  const body = await asJson(res);
  return (body.entries ?? []) as CommissionEntry[];
}

/** Admin: release held commissions for payout (sticky across recompute). */
export async function releaseCommissions(ids: string[]): Promise<void> {
  const res = await fetch("/api/ledger?action=release", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  await asJson(res);
}

/** Admin: recompute the whole tenant's commission ledger from current data. */
export async function recomputeLedger(): Promise<void> {
  const res = await fetch("/api/ledger?action=recompute", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  await asJson(res);
}
