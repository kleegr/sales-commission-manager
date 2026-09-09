/** Explicit, additive migration. Never run during a request. */
export const EXPERIENCE_SCHEMA_SQL = `
ALTER TABLE salespeople ADD COLUMN IF NOT EXISTS tracker_profile jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE salespeople ADD COLUMN IF NOT EXISTS source_contact_id text;
CREATE UNIQUE INDEX IF NOT EXISTS salespeople_source_contact ON salespeople(tenant_id,source_contact_id) WHERE source_contact_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS tracker_preferences (
 tenant_id text PRIMARY KEY REFERENCES tenants(id), preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS media_folders (
 id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), name text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id), UNIQUE(tenant_id,name)
);
ALTER TABLE media_resources ADD COLUMN IF NOT EXISTS folder_id text;
CREATE UNIQUE INDEX IF NOT EXISTS media_resources_tenant_id ON media_resources(tenant_id,id);
CREATE TABLE IF NOT EXISTS tracker_files (
 id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), media_id text NOT NULL,
 name text NOT NULL, mime text NOT NULL, content bytea NOT NULL, size integer NOT NULL CHECK(size>0 AND size<=2000000),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,media_id),
 FOREIGN KEY(tenant_id,media_id) REFERENCES media_resources(tenant_id,id)
);
INSERT INTO schema_migrations(id) VALUES('0013_tracker_experience') ON CONFLICT DO NOTHING;
`;
