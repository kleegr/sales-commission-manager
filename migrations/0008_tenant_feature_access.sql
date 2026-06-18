-- ============================================================================
-- 0008_tenant_feature_access.sql
--
-- Agency/owner control over which product areas a tenant (sub-account) may use.
-- This is the human-readable mirror of the same migration in
-- api/_lib/migrations.ts (MIGRATIONS_SQL), which ensureSchema() applies on every
-- cold start. Stored as OVERRIDES: absence of a row means the feature is
-- ENABLED (features are on by default, so a brand-new tenant has the full
-- product). Tenant-scoped; managed only by owner/admin via /api/features.
--
-- Idempotent: safe to run repeatedly.
-- ============================================================================

CREATE TABLE IF NOT EXISTS tenant_feature_access (
  tenant_id           TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  feature             TEXT NOT NULL,        -- commissions | sales_portal | affiliate_portal | proposals | contracts | ai | payouts | reports
  enabled             BOOLEAN NOT NULL DEFAULT true,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id  TEXT,
  PRIMARY KEY (tenant_id, feature)
);

CREATE INDEX IF NOT EXISTS idx_feature_access_tenant ON tenant_feature_access(tenant_id);

INSERT INTO schema_migrations (id) VALUES ('0008_tenant_feature_access')
ON CONFLICT (id) DO NOTHING;
