// ============================================================================
// scripts/seed.ts  —  seed demo tenants + data into Neon/Postgres.
//
//   npm run db:seed            # seed only if the DB has no tenants yet
//   npm run db:seed -- --reset # wipe + reseed the two demo tenants
//
// Creates two tenants to prove multi-tenant isolation:
//   • demo  → "Northwind Agency — Demo"  (full demo dataset)
//   • acme  → "Acme Partners"            (a scaled-down variant)
//
// Connection string is read from the environment (see scripts/migrate.ts).
// ============================================================================

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

loadDotEnvIfPresent();

if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
  console.error(
    "\n✗ No DATABASE_URL (or POSTGRES_URL) found. See scripts/migrate.ts for setup.\n",
  );
  process.exit(1);
}

const reset = process.argv.includes("--reset") || process.env.RESET === "1";

const { ensureSchema, seedIfEmpty, seedAll, listTenants } = await import(
  "../api/_lib/repository.ts"
);

console.log("→ Ensuring schema…");
await ensureSchema();

if (reset) {
  console.log("→ Reset requested: wiping and reseeding demo tenants…");
  await seedAll();
} else {
  const result = await seedIfEmpty();
  if (result.seeded) {
    console.log("→ Database was empty: seeded demo tenants.");
  } else {
    console.log(
      `→ Tenants already present (${result.tenants.join(", ")}); nothing to do. ` +
        "Use --reset to force.",
    );
  }
}

const tenants = await listTenants();
console.log("✓ Seed complete. Tenants now in the database:");
for (const t of tenants) {
  console.log(`   • ${t.slug.padEnd(8)} ${t.name}  (ghl: ${t.ghl_location_id ?? "—"})`);
}
process.exit(0);

// --- tiny .env loader (no dependency) --------------------------------------
function loadDotEnvIfPresent() {
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
