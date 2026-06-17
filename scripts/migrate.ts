// ============================================================================
// scripts/migrate.ts  —  apply the database schema to Neon/Postgres.
//
//   npm run db:migrate
//
// Reads the connection string from the environment (DATABASE_URL or any of the
// fallbacks listed in api/_lib/db.ts). For local use you can either:
//   export DATABASE_URL="postgres://..."   &&  npm run db:migrate
// or put it in a local .env file (this script loads .env automatically).
//
// The schema is idempotent (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT
// EXISTS), so running it repeatedly is safe.
// ============================================================================

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

loadDotEnvIfPresent();

if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
  console.error(
    "\n✗ No DATABASE_URL (or POSTGRES_URL) found.\n" +
      "  Set it in your shell or in a .env file, e.g.\n" +
      '    DATABASE_URL="postgres://user:pass@host/db?sslmode=require"\n',
  );
  process.exit(1);
}

// Import AFTER env is loaded, because api/_lib/db.ts resolves the connection
// string at module-evaluation time.
const { ensureSchema } = await import("../api/_lib/repository.ts");
const { connectionEnvVar } = await import("../api/_lib/db.ts");

console.log(`→ Applying schema using connection from ${connectionEnvVar}…`);
await ensureSchema();
console.log("✓ Schema applied (tables + indexes are in place).");
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
