// Tenant feature-access helper shared by the document/AI endpoints.
//
// Flags are DB-backed (tenant_feature_access) and ENABLED BY DEFAULT: a tenant
// with no override rows gets the full product. The tenant_id always comes from
// the session, so there is no cross-tenant read. /api/features owns writes; this
// is the read path the proposals/contracts/ai endpoints use to gate access.
import { query } from "./db.js";
import { mergeFeatureRows, type FeatureFlags, type FeatureKey } from "./handlers.js";

/** Effective (default-on + overrides) flag map for one tenant. */
export async function readTenantFlags(tenantId: string): Promise<FeatureFlags> {
  const { rows } = await query<{ feature: string; enabled: boolean }>(
    `SELECT feature, enabled FROM tenant_feature_access WHERE tenant_id = $1`,
    [tenantId],
  );
  return mergeFeatureRows(rows);
}

/** True if a single feature is enabled for the tenant (default on). */
export async function tenantFeatureEnabled(tenantId: string, key: FeatureKey): Promise<boolean> {
  const flags = await readTenantFlags(tenantId);
  return flags[key] !== false;
}
