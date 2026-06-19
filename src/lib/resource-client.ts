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

import type { FeatureFlags, FeatureKey } from "./features";

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

// ---- Agency overview -------------------------------------------------------
// Cross-sub-account rollups for the agency / super-admin view. Server-owned and
// access-controlled (owner/admin only; ALL tenants in review mode, otherwise
// just the caller's own tenant). The client never sends a tenant id.

interface PayoutBucket {
  count: number;
  amount: number;
}

export interface AgencyTenantRollup {
  slug: string;
  name: string;
  status: string;
  appEnabled: boolean;
  ghlLocationId: string | null;
  counts: {
    salespeople: number;
    activeSalespeople: number;
    clients: number;
    activeClients: number;
    plans: number;
    payments: number;
    payouts: number;
    documents: number;
  };
  revenue: { gross: number; refunds: number; net: number };
  commissions: {
    paid: number;
    pending: number;
    held: number;
    clawedBack: number;
    projected: number;
    liability: number;
  };
  payouts: {
    submitted: PayoutBucket;
    approved: PayoutBucket;
    paid: PayoutBucket;
    rejected: PayoutBucket;
    pendingAmount: number;
  };
  documents: { total: number; proposals: number; contracts: number; signed: number; sent: number; draft: number };
  features: FeatureFlags;
  disabledFeatures: FeatureKey[];
  lastActivityAt: string | null;
}

export interface AgencySummary {
  tenantCount: number;
  activeTenants: number;
  totalRevenue: number;
  totalCommissionsPaid: number;
  totalCommissionLiability: number;
  totalSalespeople: number;
  totalClients: number;
  totalPayoutsPending: number;
  totalDocuments: number;
}

export interface AgencyOverview {
  scope: "agency" | "tenant";
  demo: boolean;
  viewer: { tenant: string; role: string };
  summary: AgencySummary;
  tenants: AgencyTenantRollup[];
  generatedAt: string;
}

/** Fetch the agency overview. Throws on non-2xx (e.g. 503 in local-storage mode). */
export async function getAgencyOverview(): Promise<AgencyOverview> {
  const res = await fetch("/api/agency", { headers: { accept: "application/json" } });
  return asJson(res);
}

// ---- AI Business Setup, Proposals & Contracts ------------------------------
// Server-owned + tenant-scoped (tenant/role from the session). Templates &
// client documents are made of structured sections; merge fields are resolved
// on the server. All OpenAI calls go through /api/ai (the key never reaches the
// browser). Each call throws on a non-2xx response (see asJson).

import type {
  AiGeneration,
  AiTarget,
  BusinessProfile,
  ClientDocument,
  DocStatus,
  DocumentKind,
  DocumentSection,
  DocumentStyle,
  DocumentTemplate,
  SectionType,
} from "../types";

// --- Business profile ---

export async function getBusinessProfile(): Promise<BusinessProfile | null> {
  const res = await fetch("/api/business-profile", { headers: { accept: "application/json" } });
  const body = await asJson(res);
  return (body?.profile ?? null) as BusinessProfile | null;
}

export async function saveBusinessProfile(profile: Partial<BusinessProfile>): Promise<BusinessProfile> {
  const res = await fetch("/api/business-profile", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(profile),
  });
  const body = await asJson(res);
  return body.profile as BusinessProfile;
}

// --- Documents (templates + client docs) ---

export interface DocumentsResponse {
  templates: DocumentTemplate[];
  documents: ClientDocument[];
  features: { proposals: boolean; contracts: boolean; ai: boolean };
}

export interface DocumentsFilter {
  kind?: DocumentKind;
  clientId?: string;
  status?: DocStatus;
}

export async function listDocuments(filter: DocumentsFilter = {}): Promise<DocumentsResponse> {
  const qs = new URLSearchParams();
  if (filter.kind) qs.set("kind", filter.kind);
  if (filter.clientId) qs.set("clientId", filter.clientId);
  if (filter.status) qs.set("status", filter.status);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const res = await fetch(`/api/documents${suffix}`, { headers: { accept: "application/json" } });
  return asJson(res);
}

async function docPost(payload: Record<string, unknown>): Promise<any> {
  const res = await fetch("/api/documents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return asJson(res);
}

export interface TemplateInput {
  kind: DocumentKind;
  name: string;
  description?: string;
  style?: DocumentStyle;
  sections?: DocumentSection[];
}

export const createTemplate = (input: TemplateInput): Promise<{ id: string }> =>
  docPost({ op: "create_template", ...input });

export const updateTemplate = (
  id: string,
  patch: Partial<Omit<TemplateInput, "kind">>,
): Promise<{ id: string }> => docPost({ op: "update_template", id, ...patch });

export const duplicateTemplate = (id: string): Promise<{ id: string }> =>
  docPost({ op: "duplicate_template", id });

export const deleteTemplate = (id: string): Promise<{ ok: true }> =>
  docPost({ op: "delete_template", id });

export type SectionScope = "template" | "document";

export const addDocSection = (
  scope: SectionScope,
  id: string,
  kind: DocumentKind,
  sectionType: SectionType,
  atIndex?: number,
): Promise<{ sections: DocumentSection[] }> =>
  docPost({ op: "section_add", scope, id, kind, sectionType, atIndex });

export const updateDocSection = (
  scope: SectionScope,
  id: string,
  sectionId: string,
  patch: { title?: string; content?: string; type?: SectionType },
): Promise<{ sections: DocumentSection[] }> =>
  docPost({ op: "section_update", scope, id, sectionId, ...patch });

export const deleteDocSection = (
  scope: SectionScope,
  id: string,
  sectionId: string,
): Promise<{ sections: DocumentSection[] }> =>
  docPost({ op: "section_delete", scope, id, sectionId });

export const reorderDocSections = (
  scope: SectionScope,
  id: string,
  orderedIds: string[],
): Promise<{ sections: DocumentSection[] }> =>
  docPost({ op: "section_reorder", scope, id, orderedIds });

export interface CreateClientDocInput {
  kind: DocumentKind;
  clientId?: string | null;
  templateId?: string | null;
  title?: string;
}

export const createClientDocument = (input: CreateClientDocInput): Promise<{ id: string }> =>
  docPost({ op: "create", ...input });

export const updateClientDocument = (
  id: string,
  patch: { title?: string; style?: DocumentStyle; sections?: DocumentSection[] },
): Promise<{ id: string }> => docPost({ op: "update_document", id, ...patch });

export const setDocumentStatus = (id: string, status: DocStatus): Promise<{ ok: true }> =>
  docPost({ op: "set_status", id, status });

export interface PreviewResponse {
  kind: DocumentKind;
  title: string;
  style: DocumentStyle;
  status?: DocStatus;
  sections: DocumentSection[];
  branding: {
    businessName: string;
    logoUrl: string;
    website: string;
    companyAddress: string;
    contactEmail: string;
    contactPhone: string;
    brandTone: string;
  } | null;
}

export const previewDocument = (
  scope: SectionScope,
  id: string,
  clientId?: string | null,
): Promise<PreviewResponse> => docPost({ op: "preview", scope, id, clientId });

// --- AI generation ---

export interface AiStatus {
  configured: boolean;
  model: string;
}

export async function aiStatus(): Promise<AiStatus> {
  const res = await fetch("/api/ai", { headers: { accept: "application/json" } });
  return asJson(res);
}

export async function listAiHistory(): Promise<AiGeneration[]> {
  const res = await fetch("/api/ai?resource=history", { headers: { accept: "application/json" } });
  const body = await asJson(res);
  return (body?.history ?? []) as AiGeneration[];
}

export interface AiGenerateInput {
  kind: DocumentKind;
  target: AiTarget;
  clientId?: string | null;
  instructions?: string;
  sectionType?: SectionType;
}

export interface AiGenerateResult {
  title: string;
  sections: DocumentSection[];
}

/**
 * Generate sections via the server (OpenAI). Throws Error("ai_not_configured")
 * when no key is set and Error("ai_disabled") when the tenant feature is off, so
 * the UI can show the right message while manual creation keeps working.
 */
export async function aiGenerate(input: AiGenerateInput): Promise<AiGenerateResult> {
  const res = await fetch("/api/ai", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op: "generate", ...input }),
  });
  return asJson(res);
}
