-- ============================================================================
-- 0010_webhook_dedupe_launch_tokens.sql
--
-- Security hardening:
--   1. Race-free webhook dedupe. The receiver previously did SELECT-then-INSERT
--      with no unique index and a dedupe key that ignored tenant_id. Add a
--      UNIQUE index over (tenant, external id) so the insert can use
--      ON CONFLICT DO NOTHING. Pre-existing duplicates are collapsed first
--      (keeping the earliest row) so the index can be created on a populated
--      database.
--   2. Single-use Kleegr launch tokens. Verified launch tokens are recorded by
--      hash and a replayed token is rejected; rows past the token's own exp are
--      deleted opportunistically on insert.
--
-- This file mirrors the same statements embedded (idempotently) in
-- api/_lib/schema.ts (SCHEMA_SQL), which ensureSchema() applies on every
-- serverless cold start. It is kept for humans / `npm run db:migrate`.
--
-- Idempotent: safe to run repeatedly.
-- ============================================================================

DO $dedupe$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_integration_events_tenant_external') THEN
    DELETE FROM integration_events a USING integration_events b
      WHERE a.external_id IS NOT NULL AND a.external_id = b.external_id
        AND COALESCE(a.tenant_id, '') = COALESCE(b.tenant_id, '')
        AND (a.created_at > b.created_at OR (a.created_at = b.created_at AND a.id > b.id));
    CREATE UNIQUE INDEX uq_integration_events_tenant_external
      ON integration_events ((COALESCE(tenant_id, '')), external_id)
      WHERE external_id IS NOT NULL;
  END IF;
END $dedupe$;

CREATE TABLE IF NOT EXISTS kleegr_launch_tokens (
  token_hash   TEXT PRIMARY KEY,          -- sha256 of the launch token
  expires_at   TIMESTAMPTZ NOT NULL,      -- the token's own exp (cleanup bound)
  consumed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (id) VALUES ('0010_webhook_dedupe_launch_tokens')
ON CONFLICT (id) DO NOTHING;
