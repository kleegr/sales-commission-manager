// ============================================================================
// FEATURES  (shared client-side feature-access metadata + route gating)
//
// The agency/owner controls which product areas a tenant (sub-account) may use
// (see /api/features). This module is the single client-side source of truth
// for the feature list and the route -> feature mapping used by the nav and the
// route guard. It MUST stay in sync with FEATURE_KEYS in api/_lib/handlers.ts.
//
// Features are ENABLED BY DEFAULT and gating FAILS OPEN: if the flag map can't
// be loaded, everything is shown, so a transient API hiccup never locks a user
// out of the product.
// ============================================================================

import type { Role } from "./roles";

export type FeatureKey =
  | "commissions"
  | "sales_portal"
  | "affiliate_portal"
  | "proposals"
  | "contracts"
  | "ai"
  | "payouts"
  | "reports";

export type FeatureFlags = Record<FeatureKey, boolean>;

/** Display metadata for the Settings editor (order is the order shown). */
export const FEATURES: { key: FeatureKey; label: string; description: string }[] = [
  { key: "commissions", label: "Commission tracking", description: "Commission ledger, holds, releases, and clawbacks." },
  { key: "payouts", label: "Payout workflow", description: "Submit, approve, and mark commission payouts as paid." },
  { key: "reports", label: "Reports & analytics", description: "Revenue, commission, and performance reporting." },
  { key: "sales_portal", label: "Sales portal", description: "The salesperson self-service portal." },
  { key: "affiliate_portal", label: "Affiliate / partner portal", description: "The affiliate and partner referral portal." },
  { key: "proposals", label: "Proposal system", description: "Build, send, and track client proposals." },
  { key: "contracts", label: "Contract system", description: "Build and track client contracts." },
  { key: "ai", label: "AI generation", description: "AI-assisted proposal and contract drafting." },
];

export const FEATURE_KEYS: FeatureKey[] = FEATURES.map((f) => f.key);

/** Every feature enabled — the default and the fail-open value. */
export function defaultFeatures(): FeatureFlags {
  return {
    commissions: true,
    sales_portal: true,
    affiliate_portal: true,
    proposals: true,
    contracts: true,
    ai: true,
    payouts: true,
    reports: true,
  };
}

/** Coerce an unknown API payload into a full flag map (fail-open: default on). */
export function coerceFeatures(input: unknown): FeatureFlags {
  const out = defaultFeatures();
  if (input && typeof input === "object") {
    for (const k of FEATURE_KEYS) {
      const v = (input as Record<string, unknown>)[k];
      if (typeof v === "boolean") out[k] = v;
    }
  }
  return out;
}

/**
 * Whether a route is visible given the tenant's feature flags + the role.
 * Routes with no feature requirement are always allowed (role gating is handled
 * separately by roles.ts / canAccess). Fails OPEN.
 */
export function featureAllowsPath(path: string, role: Role, flags: FeatureFlags): boolean {
  const startsWith = (base: string) => path === base || path.startsWith(base + "/");

  if (startsWith("/ledger")) return flags.commissions;
  if (startsWith("/payouts")) return flags.payouts;
  if (startsWith("/reports")) return flags.reports;
  // Documents page hosts both proposals and contracts — visible if either is on.
  if (startsWith("/documents")) return flags.proposals || flags.contracts;
  if (startsWith("/portal")) {
    if (role === "affiliate" || role === "partner") return flags.affiliate_portal;
    if (role === "salesperson") return flags.sales_portal;
    return true; // admins/managers previewing a portal aren't feature-gated
  }
  return true;
}
