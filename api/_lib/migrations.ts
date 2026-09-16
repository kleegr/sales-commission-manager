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

-- 0010 — Kleegr Smart Productivity / GoHighLevel mapping ---------------------
-- Sales Commission Manager integrates with GoHighLevel ONLY through Kleegr
-- Smart Productivity. These nullable, tenant-scoped columns map our rows to
-- their Kleegr (and underlying GHL) identifiers so a launch/sync can link data
-- idempotently. Everything is additive and idempotent: existing demo/review
-- data is untouched, and a row with no Kleegr ids behaves exactly as before.
--
-- NOTE: ghl_location_id (tenants) and ghl_contact_id / ghl_opportunity_id
-- (clients) already existed from the original "GoHighLevel-ready" schema, so
-- they are intentionally NOT re-added here.

-- tenants == Kleegr sub-account == GoHighLevel location
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS kleegr_sub_account_id    TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS kleegr_connected_at      TIMESTAMPTZ;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS kleegr_connection_status TEXT;  -- connected | configuring | error | disconnected
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS kleegr_last_sync_at      TIMESTAMPTZ;
-- one tenant per Kleegr sub-account (partial unique: ignores NULLs / demo rows)
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenants_kleegr_sub_account
  ON tenants(kleegr_sub_account_id) WHERE kleegr_sub_account_id IS NOT NULL;

-- users (logins) carry their Kleegr Smart Productivity identity + role/permissions
ALTER TABLE users ADD COLUMN IF NOT EXISTS kleegr_user_id     TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS kleegr_role        TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS kleegr_permissions JSONB;
CREATE INDEX IF NOT EXISTS idx_users_kleegr_user ON users(tenant_id, kleegr_user_id);

-- salespeople can also be linked to a Kleegr user (sales reps synced from GHL)
ALTER TABLE salespeople ADD COLUMN IF NOT EXISTS kleegr_user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_salespeople_kleegr_user ON salespeople(tenant_id, kleegr_user_id);

-- clients == GHL contact (+ at most one linked opportunity, matching the
-- existing "client = contact + opportunity" modeling of this schema)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS kleegr_contact_id     TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS kleegr_source         TEXT;  -- manual | kleegr_imported | kleegr_linked
ALTER TABLE clients ADD COLUMN IF NOT EXISTS kleegr_opportunity_id TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS pipeline_id           TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS stage_id              TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS opportunity_status    TEXT;
CREATE INDEX IF NOT EXISTS idx_clients_kleegr_contact     ON clients(tenant_id, kleegr_contact_id);
CREATE INDEX IF NOT EXISTS idx_clients_kleegr_opportunity ON clients(tenant_id, kleegr_opportunity_id);

INSERT INTO schema_migrations (id) VALUES ('0010_kleegr_integration')
ON CONFLICT (id) DO NOTHING;
-- 0011: live directory provenance and concurrent snapshot protection.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS ghl_directory_sync JSONB;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS data_revision BIGINT NOT NULL DEFAULT 0;
ALTER TABLE salespeople ADD COLUMN IF NOT EXISTS ghl_user_id TEXT;
ALTER TABLE salespeople ADD COLUMN IF NOT EXISTS ghl_role TEXT;
ALTER TABLE salespeople ADD COLUMN IF NOT EXISTS ghl_synced_at TIMESTAMPTZ;
ALTER TABLE salespeople ADD COLUMN IF NOT EXISTS ghl_active BOOLEAN;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS ghl_synced_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS uq_salespeople_ghl_user ON salespeople(tenant_id, ghl_user_id) WHERE ghl_user_id IS NOT NULL;
-- Retire only the exact built-in demo workspaces. Real linked workspaces are preserved.
UPDATE tenants SET status = 'archived', updated_at = now()
 WHERE kleegr_sub_account_id IS NULL AND (
  (id = 'tenant_demo' AND slug = 'demo' AND ghl_location_id = 'ghl_loc_demo_001') OR
  (id = 'tenant_acme' AND slug = 'acme' AND ghl_location_id = 'ghl_loc_acme_002'));
INSERT INTO schema_migrations (id) VALUES ('0011_live_directory') ON CONFLICT (id) DO NOTHING;

-- 0010_webhook_dedupe_launch_tokens (mirrored in
-- migrations/0010_webhook_dedupe_launch_tokens.sql, named for the on-disk
-- sequence) — security hardening for a LIVE database:
--   1. Race-free webhook dedupe: a UNIQUE index over (tenant, external id) so
--      the receiver can INSERT ... ON CONFLICT DO NOTHING instead of the old
--      racy SELECT-then-INSERT. The DO block is a no-op once the index exists;
--      on the first run it collapses pre-existing duplicate rows (keeping the
--      earliest) so the index can be created on an already-populated database.
--   2. Single-use Kleegr launch tokens: consumed token hashes are recorded and
--      a replay is rejected; expired rows are swept on insert by launch.ts.
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

-- 0016 — FLOW 4: proposal send → public approval → auto client + receipt -----
-- A document can now be addressed to a PROSPECT (no client row yet; \`prospect\`
-- JSONB holds name/email/company/phone/fees) and shared through a public
-- approval link. \`public_token\` stores ONLY the sha256 of the link token (the
-- raw token is returned once by the send/link ops, like sessions + launch
-- tokens). Acceptance stamps the accepted_* columns, and the ids of the rows
-- the acceptance created (client, opportunity, pending receipt event key) are
-- recorded so the UI can link to them. All columns are nullable/additive.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS public_token           TEXT UNIQUE;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS token_expires_at       TIMESTAMPTZ;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS prospect               JSONB;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS sent_to                TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS accepted_at            TIMESTAMPTZ;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS accepted_by_name       TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS accepted_email         TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS accepted_ip            TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS signature_data         TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS created_client_id      TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS created_opportunity_id TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS receipt_event_key      TEXT;
-- Sliding-window rate limit for the unauthenticated /api/proposal endpoint
-- (same fail-open pattern as login_attempts in rate-limit.ts; rows older than
-- the window are pruned opportunistically on insert).
CREATE TABLE IF NOT EXISTS proposal_access_log (
  id          BIGSERIAL PRIMARY KEY,
  ip          TEXT NOT NULL DEFAULT '',
  ok          BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_proposal_access_ip_time ON proposal_access_log(ip, created_at DESC);
INSERT INTO schema_migrations (id) VALUES ('0016_proposal_approval_flow')
ON CONFLICT (id) DO NOTHING;

-- 0017 — pipeline → commission policy ---------------------------------------
-- Mirrors the tracker-schema.ts column so a deployed workspace picks it up on
-- cold start without a manual scripts/migrate-tracker.ts run. Guarded: the
-- tracker tables only exist once the tracker has been installed.
DO $pipeline_policy$
BEGIN
  IF to_regclass('public.tracker_workspaces') IS NOT NULL THEN
    EXECUTE $q$ALTER TABLE tracker_workspaces ADD COLUMN IF NOT EXISTS pipeline_policy jsonb NOT NULL DEFAULT '{"pipelineId":null,"wonStageIds":[],"treatStatusWonAsWon":true,"auto":false,"receipt":"pending"}'$q$;
  END IF;
END
$pipeline_policy$;
INSERT INTO schema_migrations (id) VALUES ('0017_pipeline_policy')
ON CONFLICT (id) DO NOTHING;

-- 0018 — document line items + campaign link + extended kinds -----------------
-- Line items are a JSONB array [{productId,name,qty,unitPriceMinor,billingKind}];
-- campaign_id links a document to a campaign. Both additive/nullable so existing
-- proposals/contracts (which store setupFee+monthly) keep working unchanged. The
-- extended document kinds (quote|invoice|payment_request) need no schema change:
-- the kind column is a free-text TEXT with a 'proposal' default and no CHECK.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS line_items JSONB;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS campaign_id TEXT;
INSERT INTO schema_migrations (id) VALUES ('0018_document_line_items')
ON CONFLICT (id) DO NOTHING;

-- 0019 — product catalog ------------------------------------------------------
-- Mirrors tracker-schema.ts so a deployed workspace picks the tables up on cold
-- start without a manual scripts/migrate-tracker.ts run. Guarded: the tracker
-- tables only exist once the tracker has been installed.
DO $products_catalog$
BEGIN
  IF to_regclass('public.tracker_workspaces') IS NOT NULL THEN
    EXECUTE $q$CREATE TABLE IF NOT EXISTS products (
      tenant_id text NOT NULL, id text NOT NULL, name text NOT NULL, sku text, category text NOT NULL DEFAULT '',
      description text NOT NULL DEFAULT '', price_minor numeric(30,0) NOT NULL DEFAULT 0, currency char(3) NOT NULL,
      billing_kind text NOT NULL DEFAULT 'one_time' CHECK (billing_kind IN ('one_time','recurring','setup')),
      recurring_interval text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'active',
      ghl_product_id text, ghl_price_id text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
      archived_at timestamptz, PRIMARY KEY(tenant_id,id))$q$;
    EXECUTE $q$CREATE UNIQUE INDEX IF NOT EXISTS uq_products_ghl ON products(tenant_id,ghl_product_id) WHERE ghl_product_id IS NOT NULL$q$;
    EXECUTE $q$CREATE INDEX IF NOT EXISTS idx_products_status ON products(tenant_id,status)$q$;
    EXECUTE $q$CREATE TABLE IF NOT EXISTS product_assignments (
      tenant_id text NOT NULL, product_id text NOT NULL, salesperson_id text NOT NULL, created_at timestamptz DEFAULT now(),
      PRIMARY KEY(tenant_id,product_id,salesperson_id),
      FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),
      FOREIGN KEY(tenant_id,salesperson_id) REFERENCES salespeople(tenant_id,id))$q$;
    EXECUTE $q$CREATE INDEX IF NOT EXISTS idx_product_assignments_sp ON product_assignments(tenant_id,salesperson_id)$q$;
    EXECUTE $q$CREATE TABLE IF NOT EXISTS campaign_product_structures (
      tenant_id text NOT NULL, campaign_id text NOT NULL, product_id text NOT NULL, plan_version_id text NOT NULL,
      PRIMARY KEY(tenant_id,campaign_id,product_id),
      FOREIGN KEY(tenant_id,campaign_id) REFERENCES campaigns(tenant_id,id),
      FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),
      FOREIGN KEY(tenant_id,plan_version_id) REFERENCES plan_versions(tenant_id,id))$q$;
    EXECUTE $q$CREATE INDEX IF NOT EXISTS idx_campaign_structures ON campaign_product_structures(tenant_id,campaign_id)$q$;
  END IF;
END
$products_catalog$;
INSERT INTO schema_migrations (id) VALUES ('0019_products_catalog')
ON CONFLICT (id) DO NOTHING;

-- 0020 — GHL-native invoicing on documents -----------------------------------
-- A document can now carry the GoHighLevel invoice it spawned on approval: the
-- returned invoice id, its lifecycle status (draft|sent|paid|void|...), and the
-- hosted pay-link URL. All additive/nullable so existing documents are unchanged.
-- ghl_invoice_id is how a paid-invoice webhook maps a payment back to our
-- document to post commission per line item (see api/_lib/ghl-invoicing.ts). The
-- existing receipt_event_key column is retained as the manual pending-receipt
-- fallback when GHL is not connected.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS ghl_invoice_id     TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS ghl_invoice_status TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS ghl_invoice_url    TEXT;
CREATE INDEX IF NOT EXISTS idx_documents_ghl_invoice ON documents(ghl_invoice_id) WHERE ghl_invoice_id IS NOT NULL;
INSERT INTO schema_migrations (id) VALUES ('0020_ghl_invoicing')
ON CONFLICT (id) DO NOTHING;

-- 0021 — per-product affiliate program --------------------------------------
-- Each product carries its own commission config; assigning a product to a rep
-- mints a stable, unguessable tracking link (product_links). Sharing the link
-- and a later purchase auto-credits the rep (commission-on-purchase is a LATER
-- wave; here we build config + links + click capture). Mirrors tracker-schema.ts
-- so a deployed workspace converges on the same shape. Guarded on the tracker
-- install; all product columns are additive/defaulted.
DO $product_commission_links$
BEGIN
  IF to_regclass('public.products') IS NOT NULL THEN
    EXECUTE $q$ALTER TABLE products ADD COLUMN IF NOT EXISTS commission_type text NOT NULL DEFAULT 'none' CHECK (commission_type IN ('none','percent','flat'))$q$;
    EXECUTE $q$ALTER TABLE products ADD COLUMN IF NOT EXISTS commission_bps int NOT NULL DEFAULT 0$q$;
    EXECUTE $q$ALTER TABLE products ADD COLUMN IF NOT EXISTS commission_flat_minor numeric(30,0) NOT NULL DEFAULT 0$q$;
    EXECUTE $q$ALTER TABLE products ADD COLUMN IF NOT EXISTS commission_hold_days int NOT NULL DEFAULT 0$q$;
    EXECUTE $q$ALTER TABLE products ADD COLUMN IF NOT EXISTS destination_url text NOT NULL DEFAULT ''$q$;
    EXECUTE $q$CREATE TABLE IF NOT EXISTS product_links (
      tenant_id text NOT NULL, link_id text NOT NULL, product_id text NOT NULL, salesperson_id text NOT NULL,
      active boolean NOT NULL DEFAULT true, created_at timestamptz DEFAULT now(),
      PRIMARY KEY(tenant_id,link_id), UNIQUE(tenant_id,product_id,salesperson_id),
      FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),
      FOREIGN KEY(tenant_id,salesperson_id) REFERENCES salespeople(tenant_id,id))$q$;
    EXECUTE $q$CREATE INDEX IF NOT EXISTS idx_product_links_sp ON product_links(tenant_id,salesperson_id)$q$;
    EXECUTE $q$CREATE INDEX IF NOT EXISTS idx_product_links_product ON product_links(tenant_id,product_id)$q$;
    EXECUTE $q$CREATE TABLE IF NOT EXISTS product_link_clicks (
      tenant_id text NOT NULL, link_id text NOT NULL, product_id text NOT NULL, salesperson_id text NOT NULL,
      created_at timestamptz DEFAULT now(), ip text NOT NULL DEFAULT '', contact_id text NOT NULL DEFAULT '')$q$;
    EXECUTE $q$CREATE INDEX IF NOT EXISTS idx_product_link_clicks_link ON product_link_clicks(link_id,created_at DESC)$q$;
    EXECUTE $q$CREATE INDEX IF NOT EXISTS idx_product_link_clicks_sp ON product_link_clicks(tenant_id,salesperson_id,created_at DESC)$q$;
  END IF;
END
$product_commission_links$;
INSERT INTO schema_migrations (id) VALUES ('0021_product_commission_links')
ON CONFLICT (id) DO NOTHING;

`;
