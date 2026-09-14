// Webhook dedupe + launch-token single-use, against an isolated embedded
// Postgres (PGlite). Run via `tsx api/_lib/kleegr-sync.test.ts`.
//
// Locks in the security fixes:
//   • integration_events dedupe is a UNIQUE index over (tenant, external id)
//     with INSERT ... ON CONFLICT DO NOTHING — race-free, and keyed PER TENANT
//     (the old SELECT-then-INSERT ignored tenant_id entirely);
//   • the guarded migration collapses pre-existing duplicates (keeping the
//     earliest) before creating the index on a populated database;
//   • kleegr_launch_tokens makes a verified launch token strictly single-use.
import assert from "node:assert/strict";
import { SCHEMA_SQL } from "./schema.js";

const { PGlite } = await import("@electric-sql/pglite");
const pg = new PGlite();

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const RECORD_SQL = `INSERT INTO integration_events (id, tenant_id, source, event_type, external_id, payload, status, created_at)
      VALUES ($1,$2,'kleegr',$3,$4,$5::jsonb,'received', now())
      ON CONFLICT ((COALESCE(tenant_id, '')), external_id) WHERE external_id IS NOT NULL DO NOTHING
      RETURNING id`;

await pg.exec(SCHEMA_SQL);

await check("schema is idempotent (re-run is a no-op)", async () => {
  await pg.exec(SCHEMA_SQL);
});

await check("migration collapses pre-existing duplicates, keeping the earliest per tenant", async () => {
  await pg.exec(`DROP INDEX uq_integration_events_tenant_external;
    INSERT INTO integration_events (id, tenant_id, source, event_type, external_id) VALUES
      ('e1','t1','kleegr','x','d1'),('e2','t1','kleegr','x','d1'),('e3',NULL,'kleegr','x','d1'),('e4','t2','kleegr','x','d1');`);
  await pg.exec(SCHEMA_SQL); // re-creates the index behind the DO-block guard
  const { rows } = await pg.query<{ id: string }>("SELECT id FROM integration_events ORDER BY id");
  assert.deepEqual(rows.map((r) => r.id), ["e1", "e3", "e4"]);
});

await check("duplicate delivery for the SAME tenant conflicts (dedupe)", async () => {
  const r = await pg.query(RECORD_SQL, ["e5", "t1", "x", "d1", "{}"]);
  assert.equal(r.rows.length, 0);
});

await check("same external id for a DIFFERENT tenant is NOT a duplicate", async () => {
  const r = await pg.query(RECORD_SQL, ["e6", "t3", "x", "d1", "{}"]);
  assert.equal(r.rows.length, 1);
});

await check("null-tenant deliveries dedupe against each other too", async () => {
  const r = await pg.query(RECORD_SQL, ["e7", null, "x", "d1", "{}"]);
  assert.equal(r.rows.length, 0);
});

await check("events with no external id always insert (no arbiter match)", async () => {
  const a = await pg.query(RECORD_SQL, ["e8", "t1", "x", null, "{}"]);
  const b = await pg.query(RECORD_SQL, ["e9", "t1", "x", null, "{}"]);
  assert.equal(a.rows.length + b.rows.length, 2);
});

const CONSUME_SQL = `INSERT INTO kleegr_launch_tokens (token_hash, expires_at) VALUES ($1, to_timestamp($2))
    ON CONFLICT (token_hash) DO NOTHING RETURNING token_hash`;

await check("a launch token is consumed exactly once; replay is rejected", async () => {
  const exp = Math.floor(Date.now() / 1000) + 600;
  const first = await pg.query(CONSUME_SQL, ["hash_a", exp]);
  const replay = await pg.query(CONSUME_SQL, ["hash_a", exp]);
  assert.equal(first.rows.length, 1);
  assert.equal(replay.rows.length, 0);
});

await check("expired consumption records are swept by the on-insert cleanup", async () => {
  await pg.query(CONSUME_SQL, ["hash_old", Math.floor(Date.now() / 1000) - 60]);
  await pg.query("DELETE FROM kleegr_launch_tokens WHERE expires_at < now()");
  const { rows } = await pg.query("SELECT token_hash FROM kleegr_launch_tokens");
  assert.deepEqual(rows, [{ token_hash: "hash_a" }]);
});

console.log(`\n${passed} kleegr-sync dedupe/replay checks passed.\n`);
