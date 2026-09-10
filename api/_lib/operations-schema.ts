/** Apply explicitly after backup; no request-time migrations. */
export const OPERATIONS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tracker_sources (
 id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), campaign_id text NOT NULL,
 name text NOT NULL, kind text NOT NULL CHECK(kind IN('funnel','website','store','form','survey','calendar')),
 url text NOT NULL, secret_hash text NOT NULL, status text NOT NULL DEFAULT 'configured',
 created_at timestamptz NOT NULL DEFAULT now(), verified_at timestamptz,
 UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,campaign_id) REFERENCES campaigns(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS tracker_inbox (
 id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), source_id text,
 provider text NOT NULL, external_id text NOT NULL, kind text NOT NULL,
 payload jsonb NOT NULL, status text NOT NULL DEFAULT 'pending', reason text,
 created_at timestamptz NOT NULL DEFAULT now(), reviewed_at timestamptz,
 UNIQUE(tenant_id,provider,external_id),
 FOREIGN KEY(tenant_id,source_id) REFERENCES tracker_sources(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS tracker_notices (
 id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), user_id text,
 title text NOT NULL, body text NOT NULL, category text NOT NULL,
 event_key text NOT NULL, read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,event_key)
);
CREATE TABLE IF NOT EXISTS tracker_email_outbox (
 id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), recipient text NOT NULL,
 subject text NOT NULL, body text NOT NULL, event_key text NOT NULL, status text NOT NULL DEFAULT 'pending',
 provider_id text, last_error text, attempts integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), attempted_at timestamptz, sent_at timestamptz,
 UNIQUE(tenant_id,event_key)
);
CREATE TABLE IF NOT EXISTS tracker_tax_documents (
 id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), salesperson_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN('W9','W8BEN','W8BENE')), filename text NOT NULL,
 encrypted_content bytea NOT NULL, status text NOT NULL DEFAULT 'submitted',
 submitted_by text NOT NULL, reviewed_by text, review_note text, created_at timestamptz NOT NULL DEFAULT now(), reviewed_at timestamptz,
 FOREIGN KEY(tenant_id,salesperson_id) REFERENCES salespeople(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS tracker_subscriptions (
 tenant_id text NOT NULL REFERENCES tenants(id), provider_id text NOT NULL, customer_id text,
 status text NOT NULL, started_at timestamptz NOT NULL, ended_at timestamptz, event_time bigint NOT NULL,
 PRIMARY KEY(tenant_id,provider_id)
);
CREATE TABLE IF NOT EXISTS tracker_provider_config (
 tenant_id text PRIMARY KEY REFERENCES tenants(id), stripe_account_id text,
 notifications_enabled boolean NOT NULL DEFAULT false, notification_email text,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tracker_stripe_account_owner ON tracker_provider_config(stripe_account_id) WHERE stripe_account_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS tracker_transfer_attempts (
 id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), payout_id text,
 mode text NOT NULL CHECK(mode IN('sandbox','live')), recipient text NOT NULL,
 amount_minor numeric(30,0) NOT NULL, currency text NOT NULL, provider_batch_id text,
 status text NOT NULL DEFAULT 'unknown', created_at timestamptz NOT NULL DEFAULT now(), confirmed_at timestamptz,
 UNIQUE(tenant_id,payout_id), FOREIGN KEY(tenant_id,payout_id) REFERENCES payout_batches(tenant_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS tracker_source_provider_event ON tracker_inbox(source_id,external_id) WHERE source_id IS NOT NULL;
INSERT INTO schema_migrations(id) VALUES('0014_connected_operations') ON CONFLICT DO NOTHING;
`;
