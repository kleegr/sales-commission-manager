import {database,trackerInstalled} from '../api/_lib/tracker-common.js';
import {OPERATIONS_SCHEMA_SQL} from '../api/_lib/operations-schema.js';
if(!process.env.DATABASE_URL)throw new Error('Supply the reviewed DATABASE_URL explicitly.');
const target=new URL(process.env.DATABASE_URL);
if(!await trackerInstalled())throw new Error('Install and verify 0012_sales_tracker first.');
if(!(await database.query("SELECT id FROM schema_migrations WHERE id='0013_tracker_experience'")).rows.length)throw new Error('Install and verify 0013_tracker_experience first.');
console.log(JSON.stringify({host:target.hostname,database:target.pathname,migration:'0014_connected_operations'}));
const count=()=>database.query("SELECT (SELECT count(*) FROM salespeople)::text AS people,(SELECT count(*) FROM clients)::text AS clients,(SELECT count(*) FROM payments)::text AS payments,(SELECT count(*) FROM commission_ledger)::text AS earnings,(SELECT count(*) FROM payout_batches WHERE status='paid')::text AS paid");
console.log(JSON.stringify({before:(await count()).rows[0]}));
if(!process.argv.includes('--apply')){console.log('Preflight complete. Repeat with --apply and TRACKER_MIGRATION_CONFIRM equal to this host after reviewing the backup.');process.exit(0);}
if(process.env.TRACKER_MIGRATION_CONFIRM!==target.hostname)throw new Error('Explicit target confirmation is required.');
await database.transaction(async db=>{await db.query("SET LOCAL lock_timeout='5s'");await db.query("SET LOCAL statement_timeout='120s'");await db.query("SELECT pg_advisory_xact_lock(hashtext('sales-tracker-migration'))");await db.query(OPERATIONS_SCHEMA_SQL);});
console.log(JSON.stringify({after:(await count()).rows[0]}));process.exit(0);
