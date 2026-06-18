-- 0009 — AI business setup + structured proposals/contracts
--
-- Upgrades the 0005 proposals/contracts foundation from a single TEXT `body`
-- to STRUCTURED, reorderable sections (a JSONB array; null/empty keeps the
-- legacy single-body behaviour). Adds the AI Business Setup profile (one per
-- tenant) and an append-only AI generation history. Everything is tenant-scoped
-- and server-owned (managed by /api/documents, /api/business-profile, /api/ai)
-- and is excluded from the /api/state snapshot replace-all.
--
-- This file mirrors the same statements embedded (idempotently) in
-- api/_lib/migrations.ts, which run automatically on every serverless cold
-- start. It is kept for humans / `npm run db:migrate`.

ALTER TABLE document_templates ADD COLUMN IF NOT EXISTS sections           JSONB;
ALTER TABLE document_templates ADD COLUMN IF NOT EXISTS description        TEXT NOT NULL DEFAULT '';
ALTER TABLE document_templates ADD COLUMN IF NOT EXISTS style              TEXT NOT NULL DEFAULT 'modern';
ALTER TABLE document_templates ADD COLUMN IF NOT EXISTS created_by_user_id TEXT;

ALTER TABLE documents ADD COLUMN IF NOT EXISTS sections JSONB;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS style    TEXT NOT NULL DEFAULT 'modern';

CREATE TABLE IF NOT EXISTS business_profiles (
  tenant_id          TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  business_name      TEXT NOT NULL DEFAULT '',
  logo_url           TEXT NOT NULL DEFAULT '',
  website            TEXT NOT NULL DEFAULT '',
  industry           TEXT NOT NULL DEFAULT '',
  address            TEXT NOT NULL DEFAULT '',
  contact_email      TEXT NOT NULL DEFAULT '',
  contact_phone      TEXT NOT NULL DEFAULT '',
  brand_tone         TEXT NOT NULL DEFAULT 'professional',
  profile            JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id TEXT
);

CREATE TABLE IF NOT EXISTS ai_generated_content (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id        TEXT,
  salesperson_id TEXT,
  kind           TEXT NOT NULL DEFAULT 'proposal',
  target         TEXT NOT NULL DEFAULT 'template',
  title          TEXT NOT NULL DEFAULT '',
  prompt         TEXT NOT NULL DEFAULT '',
  content        JSONB,
  model          TEXT NOT NULL DEFAULT '',
  client_id      TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_content_tenant ON ai_generated_content(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_content_sp     ON ai_generated_content(tenant_id, salesperson_id);

INSERT INTO schema_migrations (id) VALUES ('0009_ai_proposals_contracts')
ON CONFLICT (id) DO NOTHING;
