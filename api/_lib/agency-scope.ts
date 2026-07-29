// ============================================================================
// AGENCY SCOPE  (pure, DB-free)
//
// The single decision that governs cross-tenant (agency) visibility on
// /api/agency. The agency principal is derived from the caller's VERIFIED
// session tenant.agency_id — NEVER from demo mode, a header, or any other client
// input. Only an agency OWNER whose tenant actually belongs to an agency may see
// across the sub-accounts under that agency; everyone else (admins, managers,
// reps) is confined to their own tenant. Unit-tested in agency-scope.test.ts.
// ============================================================================

export type AgencyScope = "agency" | "tenant";

/**
 * Resolve how wide a caller may see.
 *   - "agency": owner of a tenant that belongs to an agency -> all sub-accounts
 *               under that agency (the endpoint still filters by agency_id).
 *   - "tenant": everyone else, and any owner whose tenant has no agency -> only
 *               their own tenant. This is the safe default; it can never widen.
 */
export function resolveAgencyScope(
  role: string,
  agencyId: string | null | undefined,
): AgencyScope {
  return role === "owner" && !!agencyId ? "agency" : "tenant";
}
