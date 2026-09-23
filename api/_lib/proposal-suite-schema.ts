export const PROPOSAL_SUITE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS notification_reads (
 tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 user_id text NOT NULL, notification_key text NOT NULL, read_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,user_id,notification_key)
);
CREATE TABLE IF NOT EXISTS proposal_autosaves (
 tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 user_id text NOT NULL, draft_key text NOT NULL, payload jsonb NOT NULL,
 version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,user_id,draft_key)
);
CREATE TABLE IF NOT EXISTS proposal_product_policies (
 tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 product_id text NOT NULL, policy jsonb NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,product_id)
);
CREATE TABLE IF NOT EXISTS proposal_policies (
 tenant_id text PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
 policy jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS proposal_workspaces (
 document_id text PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
 tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 options jsonb NOT NULL DEFAULT '{}', version integer NOT NULL DEFAULT 0,
 approval_status text NOT NULL DEFAULT 'not_requested', approval_hash text,
 requested_by text, reviewed_by text, review_note text, reviewed_at timestamptz,
 parent_id text, revision_kind text, shared_snapshot jsonb,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_proposal_workspace_tenant ON proposal_workspaces(tenant_id,parent_id);
CREATE TABLE IF NOT EXISTS proposal_events (
 id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 document_id text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 kind text NOT NULL, actor text NOT NULL, detail text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_proposal_events_doc ON proposal_events(tenant_id,document_id,created_at);
CREATE TABLE IF NOT EXISTS proposal_messages (
 id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 document_id text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 author text NOT NULL, source text NOT NULL, message text NOT NULL,
 request_change boolean NOT NULL DEFAULT false, attachment_url text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_proposal_messages_doc ON proposal_messages(tenant_id,document_id,created_at);
CREATE TABLE IF NOT EXISTS proposal_share_tokens (
 token_hash text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 document_id text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_proposal_tokens_doc ON proposal_share_tokens(tenant_id,document_id);
CREATE TABLE IF NOT EXISTS proposal_handover_tasks (
 id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 document_id text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 task_key text NOT NULL, title text NOT NULL, status text NOT NULL DEFAULT 'todo',
 owner_id text, completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,document_id,task_key)
);
INSERT INTO schema_migrations(id) VALUES ('0022_proposal_workspace') ON CONFLICT DO NOTHING;
`;
