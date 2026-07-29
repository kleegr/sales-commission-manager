// ============================================================================
// scripts/migrate-financial.ts  --  deploy-time FINANCIAL-INTEGRITY migration.
//
//   DATABASE_URL="postgres://..." npx tsx scripts/migrate-financial.ts
//
// This is a STANDALONE, IDEMPOTENT migration the owner runs MANUALLY at deploy
// time. It is deliberately NOT wired into the cold-start ensureSchema() chain
// (api/_lib/repository.ts): it adds money-path FOREIGN KEYs and partial UNIQUE
// indexes that would ABORT a request if the live data still contained orphans or
// duplicates, so it must only run under an operator's eye, once the pre-flight
// is clean.
//
// It runs in two phases:
//
//   1. PRE-FLIGHT (read-only) counts the four classes of bad data the new
//      constraints would reject. The counts are always printed. If ANY count is
//      greater than zero the script prints a WARNING and EXITS WITHOUT touching
//      the schema, so the data is cleaned first and no constraint creation can
//      fail half-way.
//
//   2. APPLY (only when pre-flight is clean) adds each constraint/index in an
//      idempotent, re-runnable way:
//        - FOREIGN KEYs are created NOT VALID (new writes are enforced; existing
//          rows are NOT scanned), each wrapped in a DO $$ ... IF NOT EXISTS
//          (SELECT 1 FROM pg_constraint WHERE conname = ...) block, because
//          Postgres has no "ADD CONSTRAINT IF NOT EXISTS".
//        - partial UNIQUE indexes use CREATE UNIQUE INDEX IF NOT EXISTS ...
//          WHERE col IS NOT NULL, which is natively idempotent.
//
// The connection string is read (by api/_lib/db.ts) from DATABASE_URL or any of
// the usual fallbacks. Because db.ts resolves it at import time, export the env
// var in the shell / deploy environment BEFORE invoking this script.
//
// This script TYPECHECKS under tsconfig.api.json (which includes "scripts") but
// requires a reachable database to actually run.
// ============================================================================

import { query, hasDb } from "../api/_lib/db.js";

/** A guarded ADD CONSTRAINT ... FOREIGN KEY ... NOT VALID (idempotent). */
interface ForeignKey {
  name: string; // constraint name (also the pg_constraint.conname guard)
  table: string;
  column: string;
  refTable: string;
  refColumn: string;
}

/** A natively-idempotent partial UNIQUE index (WHERE col IS NOT NULL). */
interface PartialUniqueIndex {
  name: string;
  table: string;
  columns: string; // comma-separated column list
  notNullColumn: string; // the column whose NULLs are excluded
}

// Money-path foreign keys. Added NOT VALID so an existing (already-verified)
// database is not re-scanned; new/updated rows are enforced immediately. Run
// `ALTER TABLE <t> VALIDATE CONSTRAINT <name>` later, once confirmed clean, to
// promote each to a fully validated constraint.
const FOREIGN_KEYS: ForeignKey[] = [
  { name: "fk_payments_client", table: "payments", column: "client_id", refTable: "clients", refColumn: "id" },
  { name: "fk_ledger_payment", table: "commission_ledger", column: "payment_id", refTable: "payments", refColumn: "id" },
  { name: "fk_ledger_rule", table: "commission_ledger", column: "commission_rule_id", refTable: "commission_rules", refColumn: "id" },
  { name: "fk_ledger_plan", table: "commission_ledger", column: "commission_plan_id", refTable: "commission_plans", refColumn: "id" },
  { name: "fk_ledger_client", table: "commission_ledger", column: "client_id", refTable: "clients", refColumn: "id" },
  { name: "fk_pbe_commission_entry", table: "payout_batch_entries", column: "commission_entry_id", refTable: "commission_ledger", refColumn: "id" },
];

// Partial UNIQUE indexes that make the app's idempotent upserts race-safe at the
// database level. Each excludes NULLs so demo/manual rows without an external id
// are unaffected.
const UNIQUE_INDEXES: PartialUniqueIndex[] = [
  { name: "uq_payments_tenant_external", table: "payments", columns: "tenant_id, external_payment_id", notNullColumn: "external_payment_id" },
  { name: "uq_clients_tenant_kleegr_contact", table: "clients", columns: "tenant_id, kleegr_contact_id", notNullColumn: "kleegr_contact_id" },
  { name: "uq_clients_tenant_ghl_contact", table: "clients", columns: "tenant_id, ghl_contact_id", notNullColumn: "ghl_contact_id" },
  { name: "uq_ledger_tenant_payment_rule", table: "commission_ledger", columns: "tenant_id, payment_id, commission_rule_id", notNullColumn: "payment_id" },
];

/** Run one COUNT query and return it as a plain number (int8 arrives as text). */
async function count(label: string, sql: string): Promise<number> {
  const { rows } = await query<{ n: number | string }>(sql);
  const n = Number(rows[0]?.n ?? 0);
  console.log(`  - ${label}: ${n}`);
  return n;
}

async function main(): Promise<void> {
  if (!hasDb()) {
    console.error(
      "\nERROR: No DATABASE_URL (or POSTGRES_URL / Neon fallback) found.\n" +
        "  Export the Neon connection string before running, e.g.\n" +
        '    DATABASE_URL="postgres://user:pass@host/db?sslmode=require" \\\n' +
        "      npx tsx scripts/migrate-financial.ts\n",
    );
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  // Phase 1 -- PRE-FLIGHT (read-only). Always prints counts; never mutates.
  // -------------------------------------------------------------------------
  console.log("Pre-flight financial-integrity checks (read-only)...");

  // Orphan commission_ledger rows whose payment_id points at a missing payment.
  const orphanLedgerPayments = await count(
    "orphan commission_ledger.payment_id (no matching payments row)",
    `SELECT count(*)::int AS n
       FROM commission_ledger cl
      WHERE cl.payment_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.id = cl.payment_id)`,
  );

  // Orphan payout_batch_entries whose commission_entry_id points at a missing
  // ledger row.
  const orphanPayoutEntries = await count(
    "orphan payout_batch_entries.commission_entry_id (no matching commission_ledger row)",
    `SELECT count(*)::int AS n
       FROM payout_batch_entries pbe
      WHERE NOT EXISTS (SELECT 1 FROM commission_ledger cl WHERE cl.id = pbe.commission_entry_id)`,
  );

  // Duplicate ledger dedup groups: more than one row for the same
  // (tenant_id, payment_id, commission_rule_id) where payment_id is not null.
  // Counts the number of DUPLICATE GROUPS (each would break uq_ledger_tenant_payment_rule).
  const duplicateLedgerGroups = await count(
    "duplicate commission_ledger dedup groups (tenant_id, payment_id, commission_rule_id)",
    `SELECT count(*)::int AS n FROM (
       SELECT tenant_id, payment_id, commission_rule_id
         FROM commission_ledger
        WHERE payment_id IS NOT NULL
        GROUP BY tenant_id, payment_id, commission_rule_id
       HAVING count(*) > 1
     ) dups`,
  );

  // Duplicate external payment ids within a tenant (where set).
  const duplicatePaymentExternalIds = await count(
    "duplicate payments (tenant_id, external_payment_id) where not null",
    `SELECT count(*)::int AS n FROM (
       SELECT tenant_id, external_payment_id
         FROM payments
        WHERE external_payment_id IS NOT NULL
        GROUP BY tenant_id, external_payment_id
       HAVING count(*) > 1
     ) dups`,
  );

  const totalIssues =
    orphanLedgerPayments + orphanPayoutEntries + duplicateLedgerGroups + duplicatePaymentExternalIds;

  if (totalIssues > 0) {
    console.warn(
      "\nWARNING: pre-flight found " +
        totalIssues +
        " integrity issue(s) above.\n" +
        "  NOT applying any constraints -- the money-path FOREIGN KEYs / UNIQUE indexes\n" +
        "  would fail (or lock in bad data) while these rows exist.\n" +
        "  Clean the listed rows (repoint or remove orphans, de-duplicate the groups),\n" +
        "  then re-run this script. No schema changes were made.\n",
    );
    process.exit(1);
  }

  console.log("Pre-flight clean -- applying constraints...");

  // -------------------------------------------------------------------------
  // Phase 2 -- APPLY (idempotent). Only reached when pre-flight is clean.
  // -------------------------------------------------------------------------
  const applied: string[] = [];

  for (const fk of FOREIGN_KEYS) {
    // Postgres has no "ADD CONSTRAINT IF NOT EXISTS", so guard on pg_constraint.
    await query(
      `DO $$
       BEGIN
         IF NOT EXISTS (
           SELECT 1 FROM pg_constraint WHERE conname = '${fk.name}'
         ) THEN
           ALTER TABLE ${fk.table}
             ADD CONSTRAINT ${fk.name}
             FOREIGN KEY (${fk.column}) REFERENCES ${fk.refTable}(${fk.refColumn}) NOT VALID;
         END IF;
       END $$;`,
    );
    applied.push(`FK  ${fk.name}  (${fk.table}.${fk.column} -> ${fk.refTable}.${fk.refColumn}, NOT VALID)`);
    console.log(`  + ${fk.name}`);
  }

  for (const idx of UNIQUE_INDEXES) {
    await query(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${idx.name}
         ON ${idx.table} (${idx.columns})
        WHERE ${idx.notNullColumn} IS NOT NULL`,
    );
    applied.push(`IDX ${idx.name}  (UNIQUE ${idx.table}(${idx.columns}) WHERE ${idx.notNullColumn} IS NOT NULL)`);
    console.log(`  + ${idx.name}`);
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log(`\nApplied ${applied.length} object(s):`);
  for (const line of applied) console.log(`    ${line}`);
  console.log(
    "\nNOTE: the FOREIGN KEYs were added NOT VALID -- they enforce every NEW write\n" +
      "immediately, but existing rows were not scanned. Once you have confirmed the\n" +
      "data is clean you can promote each to fully validated with:\n",
  );
  for (const fk of FOREIGN_KEYS) {
    console.log(`    ALTER TABLE ${fk.table} VALIDATE CONSTRAINT ${fk.name};`);
  }
  console.log("");
  process.exit(0);
}

main().catch((err) => {
  console.error("migrate-financial failed:", err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
