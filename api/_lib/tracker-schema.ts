// Explicit additive migration. Never run from a request/cold start.
export const TRACKER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tracker_workspaces (
 tenant_id text PRIMARY KEY REFERENCES tenants(id), currency text NOT NULL DEFAULT 'USD',
 timezone text NOT NULL DEFAULT 'UTC', attribution_policy jsonb NOT NULL DEFAULT '{"version":1,"precedence":["referral_link","referral_code","field_mapping","manual"],"touch":"first","windowDays":30,"reassignment":"future_only"}',
 payout_terms jsonb NOT NULL DEFAULT '{"separateApprover":true,"method":"manual"}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS external_users (
 tenant_id text NOT NULL REFERENCES tenants(id), provider text NOT NULL DEFAULT 'ghl', external_id text NOT NULL,
 name text NOT NULL, email text NOT NULL DEFAULT '', phone text NOT NULL DEFAULT '', provider_role text NOT NULL DEFAULT '',
 active boolean NOT NULL DEFAULT true, synced_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,provider,external_id)
);
CREATE TABLE IF NOT EXISTS teams (
 id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), name text NOT NULL,
 manager_user_id text, archived_at timestamptz, UNIQUE(tenant_id,id), UNIQUE(tenant_id,name)
);
ALTER TABLE salespeople ADD COLUMN IF NOT EXISTS team_id text;
ALTER TABLE salespeople ADD COLUMN IF NOT EXISTS enrolled_at timestamptz;
ALTER TABLE salespeople ADD COLUMN IF NOT EXISTS enrolled_by text;
ALTER TABLE salespeople ADD COLUMN IF NOT EXISTS parent_salesperson_id text;
ALTER TABLE salespeople ADD COLUMN IF NOT EXISTS archived_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS uq_salespeople_tenant_id ON salespeople(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_tenant_id ON users(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_clients_tenant_id ON clients(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_plans_tenant_id ON commission_plans(tenant_id,id);
CREATE TABLE IF NOT EXISTS plan_versions (
 id text PRIMARY KEY, tenant_id text NOT NULL, plan_id text NOT NULL, version integer NOT NULL,
 effective_from date NOT NULL, config jsonb NOT NULL, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,plan_id,version), FOREIGN KEY(tenant_id,plan_id) REFERENCES commission_plans(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS plan_assignments (
 id text PRIMARY KEY, tenant_id text NOT NULL, salesperson_id text NOT NULL, plan_version_id text NOT NULL,
 effective_from date NOT NULL, effective_to date, product_id text, campaign_id text, created_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), CHECK(effective_to IS NULL OR effective_to >= effective_from),
 FOREIGN KEY(tenant_id,salesperson_id) REFERENCES salespeople(tenant_id,id),
 FOREIGN KEY(tenant_id,plan_version_id) REFERENCES plan_versions(tenant_id,id)
);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS original_source text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS referrer_id text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS owner_external_id text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS closer_id text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS attribution_method text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS attribution_evidence text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS attribution_at timestamptz;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS attribution_policy_version integer;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS attribution_status text NOT NULL DEFAULT 'unattributed';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS customer_since timestamptz;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS campaign_id text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS provider_attribution_fields jsonb NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS opportunities (
 id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), external_id text, client_id text,
 name text NOT NULL, pipeline_id text, stage_id text, owner_id text, owner_external_id text, closer_id text,
 value_minor numeric(30,0) NOT NULL DEFAULT 0, currency text NOT NULL, status text NOT NULL DEFAULT 'open',
 source text NOT NULL DEFAULT 'manual', won_at timestamptz, provider_updated_at timestamptz,
 synced_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,source,external_id),
 FOREIGN KEY(tenant_id,client_id) REFERENCES clients(tenant_id,id), FOREIGN KEY(tenant_id,owner_id) REFERENCES salespeople(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS attribution_events (
 id text PRIMARY KEY, tenant_id text NOT NULL, client_id text NOT NULL, kind text NOT NULL,
 previous_id text, participant_id text, method text NOT NULL, evidence text NOT NULL, reason text NOT NULL,
 policy_version integer NOT NULL, actor_id text, occurred_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,client_id) REFERENCES clients(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS attribution_reviews (
 id text PRIMARY KEY, tenant_id text NOT NULL, client_id text NOT NULL, candidate_id text,
 method text NOT NULL, evidence text NOT NULL, reason text NOT NULL, status text NOT NULL DEFAULT 'pending',
 created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz,
 FOREIGN KEY(tenant_id,client_id) REFERENCES clients(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS campaigns (
 id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), name text NOT NULL,
 description text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'draft', starts_at date, ends_at date,
 destination_url text, conversion_mode text NOT NULL DEFAULT 'native', verification_status text NOT NULL DEFAULT 'configured',
 product_ids jsonb NOT NULL DEFAULT '[]', plan_version_id text, tracking_policy jsonb NOT NULL DEFAULT '{"windowDays":30}',
 assets jsonb NOT NULL DEFAULT '[]', terms text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,plan_version_id) REFERENCES plan_versions(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS campaign_participants (
 tenant_id text NOT NULL, campaign_id text NOT NULL, salesperson_id text NOT NULL,
 link_id text NOT NULL UNIQUE, active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,campaign_id,salesperson_id),
 FOREIGN KEY(tenant_id,campaign_id) REFERENCES campaigns(tenant_id,id),
 FOREIGN KEY(tenant_id,salesperson_id) REFERENCES salespeople(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS referral_clicks (
 id text PRIMARY KEY, tenant_id text NOT NULL, campaign_id text NOT NULL, salesperson_id text NOT NULL,
 link_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 FOREIGN KEY(tenant_id,campaign_id) REFERENCES campaigns(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS referral_conversions (
 id text PRIMARY KEY, tenant_id text NOT NULL, campaign_id text NOT NULL, click_id text NOT NULL REFERENCES referral_clicks(id),
 client_id text NOT NULL, dedupe_key text NOT NULL, source text NOT NULL, consent_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,campaign_id,dedupe_key),
 FOREIGN KEY(tenant_id,client_id) REFERENCES clients(tenant_id,id)
);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS amount_minor numeric(30,0);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS currency text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS event_key text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS receipt_status text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS parent_payment_id text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS opportunity_id text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS campaign_id text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS financial_inputs jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_event ON payments(tenant_id,event_key) WHERE event_key IS NOT NULL;
ALTER TABLE commission_ledger ADD COLUMN IF NOT EXISTS amount_minor numeric(30,0);
ALTER TABLE commission_ledger ADD COLUMN IF NOT EXISTS currency text;
ALTER TABLE commission_ledger ADD COLUMN IF NOT EXISTS event_key text;
ALTER TABLE commission_ledger ADD COLUMN IF NOT EXISTS plan_version_id text;
ALTER TABLE commission_ledger ADD COLUMN IF NOT EXISTS applied_inputs jsonb;
ALTER TABLE commission_ledger ADD COLUMN IF NOT EXISTS explanation text;
ALTER TABLE commission_ledger ADD COLUMN IF NOT EXISTS reverses_entry_id text;
ALTER TABLE commission_ledger ADD COLUMN IF NOT EXISTS recovery_status text;
ALTER TABLE commission_ledger ADD COLUMN IF NOT EXISTS campaign_id text;
ALTER TABLE commission_ledger ADD COLUMN IF NOT EXISTS opportunity_id text;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_event ON commission_ledger(tenant_id,event_key) WHERE event_key IS NOT NULL;
ALTER TABLE payout_batches ADD COLUMN IF NOT EXISTS amount_minor numeric(30,0);
ALTER TABLE payout_batches ADD COLUMN IF NOT EXISTS currency text;
ALTER TABLE payout_batches ADD COLUMN IF NOT EXISTS submitted_by_user_id text;
ALTER TABLE payout_batches ADD COLUMN IF NOT EXISTS released_amount_minor numeric(30,0) NOT NULL DEFAULT 0;
ALTER TABLE payout_batches ADD COLUMN IF NOT EXISTS reconciliation_status text NOT NULL DEFAULT 'unreconciled';
CREATE TABLE IF NOT EXISTS payout_reservations (
 tenant_id text NOT NULL, entry_id text NOT NULL, payout_id text NOT NULL REFERENCES payout_batches(id),
 amount_minor numeric(30,0) NOT NULL, PRIMARY KEY(tenant_id,entry_id)
);
CREATE TABLE IF NOT EXISTS payout_settlements (
 id text PRIMARY KEY, tenant_id text NOT NULL, payout_id text NOT NULL REFERENCES payout_batches(id),
 amount_minor numeric(30,0) NOT NULL, currency text NOT NULL, method text NOT NULL, reference text NOT NULL,
 recipient text NOT NULL, status text NOT NULL, actor_id text NOT NULL, settled_at timestamptz NOT NULL,
 note text NOT NULL DEFAULT '', UNIQUE(tenant_id,payout_id,reference)
);
CREATE TABLE IF NOT EXISTS sync_runs (
 id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), resource text NOT NULL, status text NOT NULL DEFAULT 'pending',
 cursor jsonb NOT NULL DEFAULT '{}', staged jsonb NOT NULL DEFAULT '[]', attempts integer NOT NULL DEFAULT 0,
 error text, next_retry_at timestamptz, started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, actor_id text NOT NULL
);
CREATE TABLE IF NOT EXISTS import_reviews (
 id text PRIMARY KEY, tenant_id text NOT NULL, resource text NOT NULL, external_id text NOT NULL,
 payload jsonb NOT NULL, status text NOT NULL DEFAULT 'pending', reason text, reviewed_by text,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,resource,external_id)
);
ALTER TABLE goals ADD COLUMN IF NOT EXISTS target_minor numeric(30,0);
ALTER TABLE goals ADD COLUMN IF NOT EXISTS currency text;
ALTER TABLE goals ADD COLUMN IF NOT EXISTS team_id text;
ALTER TABLE milestones ADD COLUMN IF NOT EXISTS threshold_minor numeric(30,0);
CREATE TABLE IF NOT EXISTS media_resources (
 id text PRIMARY KEY, tenant_id text NOT NULL, campaign_id text, title text NOT NULL, url text NOT NULL,
 description text NOT NULL DEFAULT '', audience text NOT NULL DEFAULT 'participants', created_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(tenant_id,campaign_id) REFERENCES campaigns(tenant_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_tenant_id ON commission_ledger(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_tenant_id ON payments(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payouts_tenant_id ON payout_batches(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_referral_conversion_click ON referral_conversions(tenant_id,click_id);
CREATE OR REPLACE FUNCTION protect_plan_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Published plan versions are immutable'; END $$;
DROP TRIGGER IF EXISTS immutable_plan_version ON plan_versions;
CREATE TRIGGER immutable_plan_version BEFORE UPDATE OR DELETE ON plan_versions FOR EACH ROW EXECUTE FUNCTION protect_plan_version();
CREATE OR REPLACE FUNCTION protect_exact_earning() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.amount_minor IS NOT NULL OR OLD.status='paid' THEN RAISE EXCEPTION 'Posted or paid earnings cannot be deleted'; END IF;
  RETURN OLD;
 END IF;
 IF OLD.status='paid' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.commission_amount IS DISTINCT FROM OLD.commission_amount OR NEW.paid_date IS DISTINCT FROM OLD.paid_date) THEN RAISE EXCEPTION 'Paid history is immutable; append an adjustment'; END IF;
 IF OLD.amount_minor IS NOT NULL AND (NEW.amount_minor IS DISTINCT FROM OLD.amount_minor OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.plan_version_id IS DISTINCT FROM OLD.plan_version_id OR NEW.applied_inputs IS DISTINCT FROM OLD.applied_inputs OR NEW.salesperson_id IS DISTINCT FROM OLD.salesperson_id OR NEW.payment_id IS DISTINCT FROM OLD.payment_id OR NEW.client_id IS DISTINCT FROM OLD.client_id OR NEW.event_key IS DISTINCT FROM OLD.event_key OR NEW.payment_date IS DISTINCT FROM OLD.payment_date) THEN RAISE EXCEPTION 'Posted earnings are immutable; append an adjustment'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS immutable_exact_earning ON commission_ledger;
CREATE TRIGGER immutable_exact_earning BEFORE UPDATE OR DELETE ON commission_ledger FOR EACH ROW EXECUTE FUNCTION protect_exact_earning();
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='tracker_reservation_entry_fk') THEN
  ALTER TABLE payout_reservations ADD CONSTRAINT tracker_reservation_entry_fk FOREIGN KEY(tenant_id,entry_id) REFERENCES commission_ledger(tenant_id,id);
  ALTER TABLE payout_reservations ADD CONSTRAINT tracker_reservation_payout_fk FOREIGN KEY(tenant_id,payout_id) REFERENCES payout_batches(tenant_id,id);
  ALTER TABLE payout_settlements ADD CONSTRAINT tracker_settlement_payout_fk FOREIGN KEY(tenant_id,payout_id) REFERENCES payout_batches(tenant_id,id);
  ALTER TABLE salespeople ADD CONSTRAINT tracker_team_fk FOREIGN KEY(tenant_id,team_id) REFERENCES teams(tenant_id,id) NOT VALID;
  ALTER TABLE salespeople ADD CONSTRAINT tracker_parent_fk FOREIGN KEY(tenant_id,parent_salesperson_id) REFERENCES salespeople(tenant_id,id) NOT VALID;
  ALTER TABLE clients ADD CONSTRAINT tracker_referrer_fk FOREIGN KEY(tenant_id,referrer_id) REFERENCES salespeople(tenant_id,id) NOT VALID;
  ALTER TABLE clients ADD CONSTRAINT tracker_closer_fk FOREIGN KEY(tenant_id,closer_id) REFERENCES salespeople(tenant_id,id) NOT VALID;
 END IF;
END $$;
-- Existing enrollments and identities survive; historical financial values are not rewritten.
INSERT INTO external_users (tenant_id,external_id,name,email,phone,provider_role,active,synced_at)
 SELECT tenant_id,ghl_user_id,name,email,phone,COALESCE(ghl_role,''),COALESCE(ghl_active,true),COALESCE(ghl_synced_at,now())
 FROM salespeople WHERE ghl_user_id IS NOT NULL ON CONFLICT DO NOTHING;
UPDATE salespeople SET enrolled_at=now() WHERE enrolled_at IS NULL;
INSERT INTO schema_migrations(id) VALUES('0012_sales_tracker') ON CONFLICT DO NOTHING;
`;
