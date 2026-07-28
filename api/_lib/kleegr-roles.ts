// ============================================================================
// LAUNCH-TOKEN ROLE MAPPING  (Smart Productivity global tier → SCM role)
//
// WHY THIS EXISTS
// ---------------
// Two DIFFERENT vocabularies flow into role mapping and they were being handled
// by one function that only knew the first:
//
//   A. GoHighLevel's own role strings, which arrive from the Kleegr gateway's
//      /users read during runInitialSync():   'admin' | 'user'
//      → mapKleegrRole() in kleegr.ts already handles these correctly.
//
//   B. Smart Productivity's GLOBAL ROLE TIER, which is what the signed LAUNCH
//      TOKEN carries in its `role` claim. Those keys are defined in Smart
//      Productivity's api/_lib/permissions-catalog.js and are:
//        'agency_admin' | 'subaccount_admin' | 'manager' | 'user' | 'viewer'
//
// mapKleegrRole() has no case for 'subaccount_admin' or 'viewer', so BOTH fell
// through to `default: salesperson`. Combined with homePathFor(), that produced
// the reported symptom set exactly:
//
//     launch claim role   → mapped   → landing page
//     subaccount_admin    → salesperson → /portal   ← BUG (should be admin, "/")
//     manager             → sales_manager → "/"       (correct — the only one that
//                                                       behaved differently)
//     user                → salesperson → /portal
//     viewer              → salesperson → /portal    ← indistinguishable from user
//
// i.e. a sub-account ADMINISTRATOR was silently downgraded to the limited
// Salesperson portal, and Viewer was indistinguishable from User.
//
// DESIGN
// ------
// This mapper owns vocabulary (B) only, and DELEGATES anything it does not
// recognise to mapKleegrRole() — so vocabulary (A) and the existing fail-safe
// ("unknown → salesperson, NEVER owner") are preserved untouched. Nothing that
// previously mapped to a given role maps to a different one now; the change is
// purely additive for keys that previously hit the default branch.
//
// SECURITY: the caller must only pass a role claim taken from a launch token
// that has already been verified server-side with Kleegr (POST /api/plugins/
// verify). Never call this with a query parameter or request-body value.
// ============================================================================

import { mapKleegrRole, type AppRole } from "./kleegr.js";

export type { AppRole };

/** Normalise 'Sub-Account Admin' / 'sub account admin' / 'SUBACCOUNT_ADMIN'. */
function normalizeTier(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/**
 * Map a Smart Productivity GLOBAL ROLE TIER (the launch token's `role` claim)
 * onto a Sales Commission Manager role.
 *
 *   agency_admin      → owner (agency placement) | admin (sub-account placement)
 *   subaccount_admin  → admin           — full sub-account administration
 *   manager           → sales_manager   — team-scoped review/approve
 *   user              → salesperson     — own records only
 *   viewer            → salesperson     — see KNOWN GAP below
 *   <anything else>   → mapKleegrRole() — preserves the GoHighLevel vocabulary
 *                                          and its "never owner" fail-safe
 *
 * KNOWN PRODUCT GAP — `viewer`: Smart Productivity distinguishes User from
 * Viewer, but SCM's role set (owner > admin > sales_manager > salesperson >
 * affiliate > partner) has NO read-only tier, and Smart Productivity's own
 * SCM_ROLE_DEFAULTS give `user` and `viewer` an identical permission set
 * (['view_commissions','view_reports']). So Viewer is mapped to `salesperson`
 * DELIBERATELY and EXPLICITLY here rather than silently via the default branch.
 * Making Viewer genuinely read-only requires a new SCM role and is out of scope
 * for this fix — it is tracked as a follow-up, not implemented here.
 */
export function mapLaunchTokenRole(
  kleegrRole: string | null | undefined,
  context: "agency" | "sub_account" = "sub_account",
): AppRole {
  switch (normalizeTier(kleegrRole)) {
    // Agency-level tier: owns the agency dashboard in an agency placement,
    // administers the single sub-account when launched inside one.
    case "agency_admin":
      return context === "agency" ? "owner" : "admin";

    // Sub-account administrator. ALWAYS an admin workspace — never the limited
    // salesperson portal, and never auto-promoted to the agency owner dashboard.
    case "subaccount_admin":
      return "admin";

    // Team-scoped: review, edit, approve, export.
    case "manager":
      return "sales_manager";

    // Own records only.
    case "user":
      return "salesperson";

    // Explicit, documented equivalence — see KNOWN PRODUCT GAP above.
    case "viewer":
      return "salesperson";

    default:
      // Not a Smart Productivity tier key — fall back to the GoHighLevel
      // vocabulary mapper, which keeps its own "unknown → salesperson, never
      // owner" fail-safe.
      return mapKleegrRole(kleegrRole, context);
  }
}
