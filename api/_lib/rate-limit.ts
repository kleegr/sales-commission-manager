// ============================================================================
// LOGIN RATE LIMITING  (brute-force protection, H-7)
//
// A DB-backed sliding window: too many FAILED logins for the same IP or email
// within LOGIN_WINDOW_MIN minutes → the endpoint returns 429 until the window
// passes. It is deliberately FAIL-OPEN: any DB error (including the table not yet
// existing) allows the login through, so throttling can never lock out a real
// user because of an infrastructure hiccup. The pure decision (overLimit) is
// unit-tested; the DB glue is thin.
// ============================================================================

import { query } from "./db.js";

export const LOGIN_WINDOW_MIN = 15;
export const LOGIN_MAX_FAILURES = 10;

let tableReady = false;

/** Create the attempts table on first use (idempotent). */
async function ensureTable(): Promise<void> {
  if (tableReady) return;
  await query(`CREATE TABLE IF NOT EXISTS login_attempts (
    id          BIGSERIAL PRIMARY KEY,
    ip          TEXT NOT NULL DEFAULT '',
    email       TEXT NOT NULL DEFAULT '',
    ok          BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_time ON login_attempts(ip, created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_login_attempts_email_time ON login_attempts(email, created_at DESC)`);
  tableReady = true;
}

/** Pure: has the failure budget been reached? */
export function overLimit(failures: number, max: number = LOGIN_MAX_FAILURES): boolean {
  return failures >= max;
}

/**
 * True if this (ip, email) is currently locked out by recent failures.
 * FAIL-OPEN on any error.
 */
export async function loginBlocked(ip: string, email: string): Promise<boolean> {
  const hasIp = ip.length > 0;
  const hasEmail = email.length > 0;
  if (!hasIp && !hasEmail) return false;
  try {
    await ensureTable();
    const parts: string[] = [];
    const params: unknown[] = [LOGIN_WINDOW_MIN];
    if (hasIp) {
      params.push(ip);
      parts.push(`ip = $${params.length}`);
    }
    if (hasEmail) {
      params.push(email);
      parts.push(`email = $${params.length}`);
    }
    const { rows } = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM login_attempts
        WHERE NOT ok AND created_at > now() - make_interval(mins => $1)
          AND (${parts.join(" OR ")})`,
      params,
    );
    return overLimit(Number(rows[0]?.n ?? 0));
  } catch {
    return false;
  }
}

/** Record one login attempt (best-effort; never throws). */
export async function recordLoginAttempt(ip: string, email: string, ok: boolean): Promise<void> {
  try {
    await ensureTable();
    await query(`INSERT INTO login_attempts (ip, email, ok) VALUES ($1,$2,$3)`, [ip, email, ok]);
  } catch {
    /* best-effort only */
  }
}
