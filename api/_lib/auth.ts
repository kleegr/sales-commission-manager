// ============================================================================
// AUTH  (server-side)
//
// A small, dependency-free authentication layer:
//   - Passwords: Node crypto.scrypt with a per-user random salt. Stored as
//     "scrypt$<saltHex>$<hashHex>". No native bcrypt dependency (keeps the
//     lockfile clean and the Vercel build fast/portable).
//   - Sessions: a 256-bit random token is set as an httpOnly cookie; only its
//     SHA-256 hash is stored in the `sessions` table, so a DB leak cannot be
//     replayed as a login.
//   - Tenant + role come from the authenticated session, never from the client.
//
// Roles (most → least privileged):
//   owner > admin > sales_manager > salesperson > affiliate > partner
// ============================================================================

import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { query } from "./db.js";

export const ROLES = [
  "owner",
  "admin",
  "sales_manager",
  "salesperson",
  "affiliate",
  "partner",
] as const;
export type Role = (typeof ROLES)[number];

/** Roles that may read/write the whole tenant dataset (admin portal). */
export const ADMIN_ROLES: Role[] = ["owner", "admin"];
/** Roles that see a team rather than the whole tenant. */
export const MANAGER_ROLES: Role[] = ["sales_manager"];
/** Roles scoped to a single salesperson/affiliate/partner record. */
export const SELF_ROLES: Role[] = ["salesperson", "affiliate", "partner"];

export function isAdminRole(role: string): boolean {
  return ADMIN_ROLES.includes(role as Role);
}

const COOKIE_NAME = "scm_session";
const SESSION_TTL_DAYS = 7;

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  try {
    const salt = Buffer.from(parts[1], "hex");
    const expected = Buffer.from(parts[2], "hex");
    const actual = scryptSync(password, salt, expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Session tokens
// ---------------------------------------------------------------------------

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export interface SessionUser {
  id: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  name: string;
  email: string;
  role: Role;
  salespersonId: string | null;
}

/** Create a session row and return the raw token to put in the cookie. */
export async function createSession(userId: string, tenantId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const id = sha256(token);
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 86400_000).toISOString();
  await query(
    `INSERT INTO sessions (id, user_id, tenant_id, expires_at) VALUES ($1,$2,$3,$4)`,
    [id, userId, tenantId, expires],
  );
  return token;
}

export async function destroySession(token: string | null): Promise<void> {
  if (!token) return;
  await query(`DELETE FROM sessions WHERE id = $1`, [sha256(token)]);
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

export function readCookie(req: VercelRequest, name = COOKIE_NAME): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

export function setSessionCookie(res: VercelResponse, token: string): void {
  const maxAge = SESSION_TTL_DAYS * 86400;
  res.setHeader("Set-Cookie", [
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAge}`,
  ]);
}

export function clearSessionCookie(res: VercelResponse): void {
  res.setHeader("Set-Cookie", [
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`,
  ]);
}

export function getSessionToken(req: VercelRequest): string | null {
  return readCookie(req);
}

// ---------------------------------------------------------------------------
// Resolve the current user from the request cookie (the auth gate)
// ---------------------------------------------------------------------------

export async function getSessionUser(req: VercelRequest): Promise<SessionUser | null> {
  const token = getSessionToken(req);
  if (!token) return null;
  const { rows } = await query<any>(
    `SELECT u.id, u.tenant_id, u.name, u.email, u.role, u.salesperson_id,
            t.slug AS tenant_slug, t.name AS tenant_name, s.expires_at
       FROM sessions s
       JOIN users u   ON u.id = s.user_id
       JOIN tenants t ON t.id = s.tenant_id
      WHERE s.id = $1`,
    [sha256(token)],
  );
  const row = rows[0];
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await query(`DELETE FROM sessions WHERE id = $1`, [sha256(token)]);
    return null;
  }
  return {
    id: row.id,
    tenantId: row.tenant_id,
    tenantSlug: row.tenant_slug,
    tenantName: row.tenant_name,
    name: row.name,
    email: row.email,
    role: row.role as Role,
    salespersonId: row.salesperson_id ?? null,
  };
}

/** Convenience guard for endpoints. Returns the user or sends 401 and null. */
export async function requireUser(
  req: VercelRequest,
  res: VercelResponse,
): Promise<SessionUser | null> {
  const user = await getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: "unauthorized" });
    return null;
  }
  return user;
}

/** Remove expired sessions (best-effort housekeeping). */
export async function pruneSessions(): Promise<void> {
  try {
    await query(`DELETE FROM sessions WHERE expires_at < now()`);
  } catch {
    /* ignore */
  }
}
