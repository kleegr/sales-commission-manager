import { database, trackerInstalled } from '../api/_lib/tracker-common.js';
import { TRACKER_SCHEMA_SQL } from '../api/_lib/tracker-schema.js';

// Deliberately does not load a .env or run from ensureSchema. Supply the reviewed target explicitly.
if (!process.env.DATABASE_URL) throw new Error('Supply DATABASE_URL for the reviewed database target.');
const target = new URL(process.env.DATABASE_URL);
console.log(JSON.stringify({host:target.hostname,database:target.pathname,installed:await trackerInstalled()}));
const checks = await database.query(`SELECT
 (SELECT count(*) FROM salespeople WHERE ghl_user_id IS NOT NULL) AS linked_participants,
 (SELECT count(*) FROM payments) AS historical_payments,
 (SELECT count(*) FROM commission_ledger) AS historical_earnings,
 (SELECT count(*) FROM payout_batches WHERE status='paid') AS paid_batches,
 (SELECT count(*) FROM schema_migrations WHERE id='0011_live_directory') AS directory_migration`);
console.log(JSON.stringify({preflight:checks.rows[0],note:'Existing financial amounts and plan assignments are not converted automatically.'}));
if (String(checks.rows[0].directory_migration)!=='1') throw new Error('Apply and verify the existing baseline migrations before this additive update.');
if (!process.argv.includes('--apply')) {console.log('Read-only preflight complete. After backup and target review, repeat with --apply and TRACKER_MIGRATION_CONFIRM=<database host>.');process.exit(0);}
if (process.env.TRACKER_MIGRATION_CONFIRM !== target.hostname) throw new Error('Explicit confirmation must equal the reviewed database host.');
await database.transaction(async db=>{await db.query("SET LOCAL lock_timeout='5s'");await db.query("SET LOCAL statement_timeout='120s'");await db.query("SELECT pg_advisory_xact_lock(hashtext('sales-tracker-migration'))");await db.query(TRACKER_SCHEMA_SQL);});
console.log('Additive migration applied. Configure each workspace explicitly; no financial imports or transfers were enabled.');
process.exit(0);
