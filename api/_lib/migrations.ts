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
`;
