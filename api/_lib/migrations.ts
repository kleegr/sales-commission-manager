// ============================================================================
// INCREMENTAL MIGRATIONS  (idempotent ALTERs + new tables)
//
// SCHEMA_SQL (schema.ts) uses CREATE TABLE IF NOT EXISTS, which is perfect for
// a fresh database but CANNOT add columns to tables that already exist in the
// live Neon database (e.g. the `users` table shipped earlier without auth
// columns). This file holds forward-only, idempotent migrations that bring an
// already-deployed database up to the current shape WITHOUT a data wipe.
//
// Every statement is safe to run on every cold start:
//   - ADD COLUMN IF NOT EXISTS
//   - CREATE TABLE IF NOT EXISTS
//   - CREATE INDEX IF NOT EXISTS
//
// ensureSchema() runs SCHEMA_SQL then MIGRATIONS_SQL, so both a brand-new and a
// previously-seeded database converge on the same structure.
// ============================================================================

export const MIGRATIONS_SQL = /* sql */ `
-- 0002 — real authentication ------------------------------------------------

-- password hashing for the users table (scrypt: salt$hash, see auth.ts)
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

-- server-side sessions (cookie holds an opaque token; we store only its hash)
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,           -- sha256(token), never the raw token
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- 0003 — sales-manager team membership --------------------------------------
-- A sales manager is a user; their team is the set of salespeople pointing at
-- them. Nullable so existing rows are unaffected.
ALTER TABLE salespeople ADD COLUMN IF NOT EXISTS manager_user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_salespeople_manager ON salespeople(manager_user_id);

-- 0004 — payout workflow history --------------------------------------------
-- Append-only log of every payout state transition (who/when/from->to). This is
-- the real database-backed payout history the workflow writes on each action.
CREATE TABLE IF NOT EXISTS payout_events (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  payout_batch_id  TEXT NOT NULL REFERENCES payout_batches(id) ON DELETE CASCADE,
  from_status      TEXT,
  to_status        TEXT NOT NULL,
  actor_user_id    TEXT,
  actor_role       TEXT,
  note             TEXT NOT NULL DEFAULT '',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payout_events_batch ON payout_events(payout_batch_id);

-- payout_batches gained richer workflow columns earlier; make sure they exist
ALTER TABLE payout_batches ADD COLUMN IF NOT EXISTS created_by_user_id  TEXT;
ALTER TABLE payout_batches ADD COLUMN IF NOT EXISTS approved_by_user_id TEXT;
ALTER TABLE payout_batches ADD COLUMN IF NOT EXISTS paid_by_user_id     TEXT;
ALTER TABLE payout_batches ADD COLUMN IF NOT EXISTS rejected_at         TEXT;
ALTER TABLE payout_batches ADD COLUMN IF NOT EXISTS canceled_at         TEXT;

-- 0005 — proposals & contracts foundation -----------------------------------
-- Tenant-scoped document templates + per-client proposals/contracts. These are
-- SERVER-OWNED (managed by /api/documents) and are intentionally NOT part of
-- the snapshot replace-all in writeState, so an admin save never wipes them.
-- e-signature is out of scope for this phase; the status column tracks the lifecycle.
CREATE TABLE IF NOT EXISTS document_templates (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL DEFAULT 'proposal',   -- proposal | contract
  name         TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL DEFAULT '',           -- supports {{company}} {{contact}} {{setup_fee}} {{monthly}} tokens
  is_default   BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_doc_templates_tenant ON document_templates(tenant_id, kind);

CREATE TABLE IF NOT EXISTS documents (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'proposal',  -- proposal | contract
  title         TEXT NOT NULL DEFAULT '',
  client_id     TEXT,
  salesperson_id TEXT,
  template_id   TEXT,
  body          TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'draft',     -- draft | sent | viewed | signed | canceled
  amount        DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_by_user_id TEXT,
  sent_at       TIMESTAMPTZ,
  viewed_at     TIMESTAMPTZ,
  signed_at     TIMESTAMPTZ,
  canceled_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_documents_tenant      ON documents(tenant_id, kind);
CREATE INDEX IF NOT EXISTS idx_documents_tenant_sp   ON documents(tenant_id, salesperson_id);
CREATE INDEX IF NOT EXISTS idx_documents_tenant_cli  ON documents(tenant_id, client_id);

-- 0006 — goals & milestones -------------------------------------------------
-- Sales goals + motivational milestones. A goal targets a measurable metric for
-- a salesperson, a manager's team, or the whole tenant, over a period. Progress
-- is COMPUTED from real data (payments / clients / commissions) — never stored —
-- so it always reflects the live ledger. Milestones are sub-thresholds of a
-- goal (e.g. 25% / 50% / 75% markers, or a bonus tier). These rows are
-- SERVER-OWNED (managed by /api/goals) and are intentionally NOT part of the
-- snapshot replace-all in writeState, so an admin save never wipes them.
CREATE TABLE IF NOT EXISTS goals (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope_type         TEXT NOT NULL DEFAULT 'salesperson', -- salesperson | team | tenant
  salesperson_id     TEXT,        -- set when scope_type = 'salesperson'
  manager_user_id    TEXT,        -- set when scope_type = 'team'
  metric             TEXT NOT NULL DEFAULT 'revenue',     -- revenue | clients_closed | referrals | mrr | commission_earned | activity
  title              TEXT NOT NULL DEFAULT '',
  target_value       DOUBLE PRECISION NOT NULL DEFAULT 0,
  period             TEXT NOT NULL DEFAULT 'monthly',     -- monthly | quarterly | custom
  period_start       TEXT,        -- ISO yyyy-mm-dd (inclusive)
  period_end         TEXT,        -- ISO yyyy-mm-dd (inclusive)
  status             TEXT NOT NULL DEFAULT 'active',      -- active | archived
  created_by_user_id TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_goals_tenant     ON goals(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_goals_tenant_sp  ON goals(tenant_id, salesperson_id);
CREATE INDEX IF NOT EXISTS idx_goals_tenant_mgr ON goals(tenant_id, manager_user_id);

CREATE TABLE IF NOT EXISTS milestones (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  goal_id         TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  title           TEXT NOT NULL DEFAULT '',
  threshold_value DOUBLE PRECISION NOT NULL DEFAULT 0,   -- in the goal's metric units
  reward          TEXT NOT NULL DEFAULT '',
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_milestones_tenant ON milestones(tenant_id);
CREATE INDEX IF NOT EXISTS idx_milestones_goal   ON milestones(goal_id);

-- 0007 — commission timing (hold / release / clawback) ----------------------
-- The timing feature is mostly DERIVED at read time (a pure resolver decides
-- held / pending / clawed_back and the release date from these durable inputs),
-- so only three new persisted columns are required:
--   commission_plans.timing        — the plan's CommissionTiming config (JSONB,
--                                     null = pay immediately, preserving legacy
--                                     behaviour for every existing plan)
--   clients.canceled_date          — when a client canceled/refunded, so the
--                                     clawback window can be measured precisely
--   commission_ledger.released_override — sticky admin "Release now" flag so a
--                                     manually released line is not re-held by a
--                                     later recompute (needed for on_approval)
-- The held / pending / clawed_back state itself rides the EXISTING
-- commission_ledger.status column — no enum/type change needed.
ALTER TABLE commission_plans   ADD COLUMN IF NOT EXISTS timing            JSONB;
ALTER TABLE clients            ADD COLUMN IF NOT EXISTS canceled_date     TEXT;
ALTER TABLE commission_ledger  ADD COLUMN IF NOT EXISTS released_override BOOLEAN NOT NULL DEFAULT false;

-- 0008 — tenant feature access ----------------------------------------------
-- Agency/owner control over which product areas a tenant (sub-account) may use.
-- Stored as OVERRIDES: absence of a row means the feature is ENABLED (features
-- are on by default, so a brand-new tenant has the full product). Tenant-scoped
-- and managed ONLY by owner/admin via /api/features. The nav + route guard hide
-- or block disabled areas, but the server remains the source of truth.
CREATE TABLE IF NOT EXISTS tenant_feature_access (
  tenant_id           TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  feature             TEXT NOT NULL,        -- commissions | sales_portal | affiliate_portal | proposals | contracts | ai | payouts | reports
  enabled             BOOLEAN NOT NULL DEFAULT true,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id  TEXT,
  PRIMARY KEY (tenant_id, feature)
);
CREATE INDEX IF NOT EXISTS idx_feature_access_tenant ON tenant_feature_access(tenant_id);

-- record this migration (kept here so repository.ts ensureSchema needs no edit)
INSERT INTO schema_migrations (id) VALUES ('0008_tenant_feature_access')
ON CONFLICT (id) DO NOTHING;

-- 0009 — AI business setup + structured proposals/contracts -----------------
-- The proposals/contracts foundation (0005) stored each template/document as a
-- single TEXT \`body\`. This slice upgrades them to STRUCTURED, reorderable
-- sections (a JSONB array; a null/empty array preserves the legacy single-body
-- behaviour, so nothing already saved breaks) and adds the AI Business Setup
-- profile + an append-only AI generation history. Everything is tenant-scoped
-- and SERVER-OWNED (managed by /api/documents, /api/business-profile, /api/ai)
-- and, like the 0005 tables, is intentionally NOT part of the /api/state
-- snapshot replace-all, so an admin save never wipes it.

ALTER TABLE document_templates ADD COLUMN IF NOT EXISTS sections           JSONB;
ALTER TABLE document_templates ADD COLUMN IF NOT EXISTS description        TEXT NOT NULL DEFAULT '';
ALTER TABLE document_templates ADD COLUMN IF NOT EXISTS style              TEXT NOT NULL DEFAULT 'modern';
ALTER TABLE document_templates ADD COLUMN IF NOT EXISTS created_by_user_id TEXT;

ALTER TABLE documents ADD COLUMN IF NOT EXISTS sections JSONB;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS style    TEXT NOT NULL DEFAULT 'modern';

-- One business profile per tenant — the AI Business Setup wizard target. The
-- merge-field-relevant answers are first-class columns; the long tail of wizard
-- answers (services, packages, scope, terms, tone, legal language, style, …)
-- rides in \`profile\` JSONB so the wizard can evolve without a migration.
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
  profile            JSONB,        -- the remaining wizard answers (see BusinessProfile)
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id TEXT
);

-- Append-only history of every AI generation (proposal/contract/section/email).
CREATE TABLE IF NOT EXISTS ai_generated_content (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id        TEXT,
  salesperson_id TEXT,
  kind           TEXT NOT NULL DEFAULT 'proposal',  -- proposal | contract | section | email
  target         TEXT NOT NULL DEFAULT 'template',  -- template | document | section | email
  title          TEXT NOT NULL DEFAULT '',
  prompt         TEXT NOT NULL DEFAULT '',
  content        JSONB,                              -- the generated sections / text
  model          TEXT NOT NULL DEFAULT '',
  client_id      TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_content_tenant ON ai_generated_content(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_content_sp     ON ai_generated_content(tenant_id, salesperson_id);

INSERT INTO schema_migrations (id) VALUES ('0009_ai_proposals_contracts')
ON CONFLICT (id) DO NOTHING;
`;
