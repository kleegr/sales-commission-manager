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
