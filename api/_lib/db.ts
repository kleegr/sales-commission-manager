// ============================================================================
// DB CONNECTION  (Neon serverless, Postgres wire protocol over WebSocket)
//
// One pooled connection per warm serverless instance. We deliberately read the
// connection string from a PRIORITY LIST of env var names, because the exact
// name depends on how Neon was attached in Vercel:
//   - Neon-native Vercel integration  -> DATABASE_URL (+ DATABASE_URL_UNPOOLED)
//   - Vercel Postgres (legacy)         -> POSTGRES_URL (+ POSTGRES_URL_NON_POOLING)
// so the app works regardless of which one is set, with zero config.
// ============================================================================

import { Pool, neonConfig, type PoolClient } from "@neondatabase/serverless";
import ws from "ws";

// The serverless driver needs a WebSocket implementation in Node (< 22 has
// none global; we set it explicitly so behaviour is identical everywhere).
neonConfig.webSocketConstructor = ws;

const CANDIDATE_ENV_VARS = [
  "DATABASE_URL",
  "POSTGRES_URL",
  "DATABASE_URL_UNPOOLED",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NON_POOLING",
  "NEON_DATABASE_URL",
] as const;

function resolveConnection(): { url: string; envVar: string | null } {
  for (const name of CANDIDATE_ENV_VARS) {
    const v = process.env[name];
    if (v && v.trim()) return { url: v.trim(), envVar: name };
  }
  return { url: "", envVar: null };
}

const { url, envVar } = resolveConnection();

/** Which env var the connection string was read from (for /api/health). */
export const connectionEnvVar = envVar;

/** True when a Neon/Postgres connection string is configured. */
export function hasDb(): boolean {
  return !!url;
}

let pool: Pool | null = null;

function getPool(): Pool {
  if (!url) {
    throw new Error(
      "No database connection string found. Set DATABASE_URL (or POSTGRES_URL) " +
        "in the Vercel project / .env. Expected the Neon connection string.",
    );
  }
  if (!pool) {
    pool = new Pool({ connectionString: url });
  }
  return pool;
}

/** Run a single query (optionally parameterised). */
export async function query<T = any>(
  text: string,
  params: unknown[] = [],
): Promise<{ rows: T[]; rowCount: number }> {
  const res = await getPool().query(text, params as any[]);
  return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
}

/** Run `fn` inside a single transaction; commits on success, rolls back on throw. */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore rollback failure */
    }
    throw err;
  } finally {
    client.release();
  }
}

export type { PoolClient };
