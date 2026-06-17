-- ============================================================================
-- 0001_init.sql  —  initial multi-tenant schema for Commission Manager
--
-- Human-readable mirror of api/_lib/schema.ts (the canonical source used by
-- the serverless ensureSchema() and by scripts/migrate.ts).
--
-- Apply with:  npm run db:migrate      (recommended; idempotent)
-- or pipe directly:  psql "$DATABASE_URL" -f migrations/0001_init.sql
-- ============================================================================

-- 0. migration bookkeeping ---------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  id          TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 1. agency accounts (the app owner / reseller above the locations) ----------
CREATE TABLE IF NOT EXISTS agency_accounts (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. tenants == GoHighLevel locations / sub-accounts -------------------------
CREATE TABLE IF NOT EXISTS tenants (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  slug             TEXT NOT NULL UNIQUE,
  ghl_location_id  TEXT,
  agency_id        TEXT REFERENCES agency_accounts(id) ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'active',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2b. GoHighLevel OAuth installs / connection state (future phase) -----------
CREATE TABLE IF NOT EXISTS ghl_connections (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ghl_location_id   TEXT,
  access_token      TEXT,
  refresh_token     TEXT,
  token_expires_at  TIMESTAMPTZ,
  scope             TEXT,
  status            TEXT NOT NULL DEFAULT 'disconnected',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. users (owner / admin / manager / rep logins — future auth) --------------
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  email           TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'owner',
  status          TEXT NOT NULL DEFAULT 'active',
  salesperson_id  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

-- 4. salespeople / affiliates / partners ------------------------------------
CREATE TABLE IF NOT EXISTS salespeople (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id             TEXT,
  name                TEXT NOT NULL,
  email               TEXT NOT NULL DEFAULT '',
  phone               TEXT NOT NULL DEFAULT '',
  role                TEXT NOT NULL DEFAULT 'salesperson',  -- salesperson | affiliate | partner
  referral_code       TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL DEFAULT 'active',        -- active | inactive | pending | rejected
  approval_status     TEXT NOT NULL DEFAULT 'approved',      -- pending | approved | rejected
  source              TEXT NOT NULL DEFAULT 'admin',         -- admin | affiliate_portal
  commission_plan_id  TEXT,
  weekly_salary       DOUBLE PRECISION,
  salary_start_date   TEXT,
  salary_end_date     TEXT,
  company_name        TEXT,
  website             TEXT,
  referral_source     TEXT,
  notes               TEXT NOT NULL DEFAULT '',
  created_at          TEXT NOT NULL DEFAULT '',
  updated_at          TEXT NOT NULL DEFAULT ''
);

-- 5. commission plans --------------------------------------------------------
CREATE TABLE IF NOT EXISTS commission_plans (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'active',
  sort_order        INTEGER NOT NULL DEFAULT 0,
  sample_setup_fee  DOUBLE PRECISION NOT NULL DEFAULT 0,
  sample_monthly    DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT '',
  updated_at        TEXT NOT NULL DEFAULT ''
);

-- 6. commission rules (typed columns for reporting + JSONB for fidelity) -----
CREATE TABLE IF NOT EXISTS commission_rules (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  commission_plan_id   TEXT NOT NULL REFERENCES commission_plans(id) ON DELETE CASCADE,
  rule_type            TEXT NOT NULL,        -- setup_fee | signup_bonus | monthly_residual | salary | adjustment
  calculation_type     TEXT NOT NULL DEFAULT 'none', -- percentage | fixed | none
  value                DOUBLE PRECISION NOT NULL DEFAULT 0,
  start_month          INTEGER,
  end_month            INTEGER,
  continues_forever    BOOLEAN NOT NULL DEFAULT false,
  weekly_salary_amount DOUBLE PRECISION,
  salary_start_date    TEXT,
  salary_end_date      TEXT,
  max_weeks            INTEGER,
  sort_order           INTEGER NOT NULL DEFAULT 0,
  is_active            BOOLEAN NOT NULL DEFAULT true,
  metadata             JSONB,
  created_at           TEXT NOT NULL DEFAULT '',
  updated_at           TEXT NOT NULL DEFAULT ''
);

-- 7. clients / customers -----------------------------------------------------
CREATE TABLE IF NOT EXISTS clients (
  id                          TEXT PRIMARY KEY,
  tenant_id                   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  salesperson_id              TEXT,
  company_name                TEXT NOT NULL DEFAULT '',
  contact_name                TEXT NOT NULL DEFAULT '',
  email                       TEXT NOT NULL DEFAULT '',
  phone                       TEXT NOT NULL DEFAULT '',
  signup_date                 TEXT NOT NULL DEFAULT '',
  setup_fee_amount            DOUBLE PRECISION NOT NULL DEFAULT 0,
  monthly_subscription_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  status                      TEXT NOT NULL DEFAULT 'active', -- active | paused | canceled | refunded
  notes                       TEXT NOT NULL DEFAULT '',
  ghl_contact_id              TEXT,
  ghl_opportunity_id          TEXT,
  created_at                  TEXT NOT NULL DEFAULT '',
  updated_at                  TEXT NOT NULL DEFAULT ''
);

-- 8. payments ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id           TEXT NOT NULL,
  salesperson_id      TEXT,
  payment_date        TEXT NOT NULL DEFAULT '',
  payment_type        TEXT NOT NULL,        -- setup_fee | monthly_subscription | refund | adjustment
  amount              DOUBLE PRECISION NOT NULL DEFAULT 0,
  payment_number      INTEGER,
  source              TEXT NOT NULL DEFAULT 'manual', -- manual | ghl | stripe | import
  external_payment_id TEXT,
  notes               TEXT NOT NULL DEFAULT '',
  created_at          TEXT NOT NULL DEFAULT '',
  updated_at          TEXT NOT NULL DEFAULT ''
);

-- 9. commission ledger -------------------------------------------------------
CREATE TABLE IF NOT EXISTS commission_ledger (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  salesperson_id       TEXT NOT NULL,
  client_id            TEXT,
  payment_id           TEXT,
  commission_plan_id   TEXT,
  commission_rule_id   TEXT,
  rule_type            TEXT NOT NULL DEFAULT 'monthly_residual',
  payment_date         TEXT NOT NULL DEFAULT '',
  payment_type         TEXT NOT NULL DEFAULT '',
  payment_amount       DOUBLE PRECISION NOT NULL DEFAULT 0,
  commission_rule_used TEXT NOT NULL DEFAULT '',
  commission_type      TEXT NOT NULL DEFAULT 'fixed',
  commission_value     DOUBLE PRECISION NOT NULL DEFAULT 0,
  commission_amount    DOUBLE PRECISION NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'pending',
  due_date             TEXT NOT NULL DEFAULT '',
  paid_date            TEXT,
  payout_batch_id      TEXT,
  is_projection        BOOLEAN NOT NULL DEFAULT false,
  notes                TEXT NOT NULL DEFAULT '',
  created_at           TEXT NOT NULL DEFAULT '',
  updated_at           TEXT NOT NULL DEFAULT ''
);

-- 10. payout batches ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS payout_batches (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  salesperson_id       TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'submitted', -- submitted | approved | paid | rejected
  total_amount         DOUBLE PRECISION NOT NULL DEFAULT 0,
  date_range_start     TEXT,
  date_range_end       TEXT,
  submitted_at         TEXT,
  approved_at          TEXT,
  paid_at              TEXT,
  created_by_user_id   TEXT,
  approved_by_user_id  TEXT,
  paid_by_user_id      TEXT,
  notes                TEXT NOT NULL DEFAULT '',
  created_at           TEXT NOT NULL DEFAULT '',
  updated_at           TEXT NOT NULL DEFAULT ''
);

-- 10b. which ledger entries belong to a payout batch -------------------------
CREATE TABLE IF NOT EXISTS payout_batch_entries (
  payout_batch_id      TEXT NOT NULL REFERENCES payout_batches(id) ON DELETE CASCADE,
  commission_entry_id  TEXT NOT NULL,
  tenant_id            TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  PRIMARY KEY (payout_batch_id, commission_entry_id)
);

-- 11. affiliate signup applications (public funnel) --------------------------
CREATE TABLE IF NOT EXISTS affiliate_applications (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  name                TEXT NOT NULL DEFAULT '',
  email               TEXT NOT NULL DEFAULT '',
  phone               TEXT NOT NULL DEFAULT '',
  company_name        TEXT,
  website_or_social   TEXT,
  referral_source     TEXT,
  message             TEXT,
  agreement_accepted  BOOLEAN NOT NULL DEFAULT false,
  status              TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 12. settings (one row per tenant) ------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  tenant_id                    TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  company_name                 TEXT NOT NULL DEFAULT '',
  theme                        TEXT NOT NULL DEFAULT 'light',
  default_setup_fee            DOUBLE PRECISION NOT NULL DEFAULT 0,
  default_monthly_subscription DOUBLE PRECISION NOT NULL DEFAULT 0,
  default_closings_per_month   DOUBLE PRECISION NOT NULL DEFAULT 0,
  default_churn_rate           DOUBLE PRECISION NOT NULL DEFAULT 0,
  projection_months            INTEGER NOT NULL DEFAULT 60,
  extra                        JSONB,
  created_at                   TEXT NOT NULL DEFAULT '',
  updated_at                   TEXT NOT NULL DEFAULT ''
);

-- 13. projection assumptions (per plan / scenario — future reporting) --------
CREATE TABLE IF NOT EXISTS projection_assumptions (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  commission_plan_id  TEXT,
  name                TEXT NOT NULL DEFAULT 'Default',
  avg_setup_fee       DOUBLE PRECISION NOT NULL DEFAULT 0,
  avg_monthly         DOUBLE PRECISION NOT NULL DEFAULT 0,
  closings_per_month  DOUBLE PRECISION NOT NULL DEFAULT 0,
  monthly_churn_pct   DOUBLE PRECISION NOT NULL DEFAULT 0,
  months              INTEGER NOT NULL DEFAULT 60,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 14. audit logs -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT,
  user_id      TEXT,
  entity_type  TEXT NOT NULL DEFAULT '',
  entity_id    TEXT,
  action       TEXT NOT NULL DEFAULT '',
  before       JSONB,
  after        JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 14b. integration events (GoHighLevel webhooks — future phase) --------------
CREATE TABLE IF NOT EXISTS integration_events (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT,
  source       TEXT NOT NULL DEFAULT 'ghl',
  event_type   TEXT NOT NULL DEFAULT '',
  external_id  TEXT,
  payload      JSONB,
  status       TEXT NOT NULL DEFAULT 'received',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- indexes for tenant-scoped lookups -----------------------------------------
CREATE INDEX IF NOT EXISTS idx_salespeople_tenant       ON salespeople(tenant_id);
CREATE INDEX IF NOT EXISTS idx_plans_tenant             ON commission_plans(tenant_id);
CREATE INDEX IF NOT EXISTS idx_rules_tenant_plan        ON commission_rules(tenant_id, commission_plan_id);
CREATE INDEX IF NOT EXISTS idx_clients_tenant           ON clients(tenant_id);
CREATE INDEX IF NOT EXISTS idx_clients_tenant_sp        ON clients(tenant_id, salesperson_id);
CREATE INDEX IF NOT EXISTS idx_payments_tenant_client   ON payments(tenant_id, client_id);
CREATE INDEX IF NOT EXISTS idx_ledger_tenant_sp         ON commission_ledger(tenant_id, salesperson_id);
CREATE INDEX IF NOT EXISTS idx_ledger_tenant_status     ON commission_ledger(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_payouts_tenant_sp        ON payout_batches(tenant_id, salesperson_id);
CREATE INDEX IF NOT EXISTS idx_audit_tenant             ON audit_logs(tenant_id);
