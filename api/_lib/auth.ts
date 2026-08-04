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
// DEMO / REVIEW MODE  (feature-flagged, no-password bypass)
//
// When enabled, the app can be reviewed without logging in: the client picks a
// tenant + role from the top "Review Mode" bar, and the server resolves the
// matching SEEDED demo user for that (tenant, role) and treats it as the
// session. This NEVER weakens real auth:
//   - real password sessions still work and always take precedence;
//   - the bypass only ever returns one of the demo users created by the seed
//     (it cannot mint an arbitrary identity);
//   - it is a review convenience only — it is OFF unless explicitly turned on.
//
// Default is OFF (production-safe). Demo/review mode is EXPLICIT OPT-IN ONLY:
// set DEMO_MODE to one of 1/true/on/enabled/yes to turn it on for a review
// deployment. Any other value — including unset/empty — keeps it OFF, so the
// login wall stays up and the seeded demo tenants/users cannot be assumed
// without a password. Turning it on is intended for pre-GoHighLevel review
// environments that hold NO real customer data.
// ---------------------------------------------------------------------------

const DEMO_COOKIE_TENANT = "scm_demo_tenant";
const DEMO_COOKIE_ROLE = "scm_demo_role";

// The ONLY tenant slugs the no-password demo bypass may ever resolve. A client
// header/cookie can pick AMONG these, but can never name a real (e.g. Kleegr)
// tenant slug, so demo mode can never be used to impersonate a real customer's
// workspace. Keep in sync with DEMO_TENANTS in repository.ts.
export const DEMO_TENANT_SLUGS = ["demo", "acme"] as const;
export function isDemoSlug(slug: string): boolean {
  return (DEMO_TENANT_SLUGS as readonly string[]).includes(slug);
}

const DEMO_AFFIRMATIVE = ["1", "true", "on", "enabled", "yes"];

/** True only in a Vercel *production* deployment (VERCEL_ENV=production). */
export function isProductionEnv(): boolean {
  return (process.env.VERCEL_ENV ?? "").trim().toLowerCase() === "production";
}

export function demoModeEnabled(): boolean {
  const v = (process.env.DEMO_MODE ?? "").trim().toLowerCase();
  // Explicit opt-in ONLY. Unset/empty (and any non-affirmative value) ⇒ OFF,
  // which is the production-safe default. Demo mode must be deliberately turned
  // on for a review deployment; it can never be on by accident.
  if (!DEMO_AFFIRMATIVE.includes(v)) return false;

  // Fail-safe HOST GUARD: the no-password demo bypass must be IMPOSSIBLE in a
  // production deployment — even if DEMO_MODE is affirmatively set (e.g. a stray
  // value left in the prod env) — UNLESS a second, explicit flag opts in for a
  // deliberately public demo on a production URL. Making "demo in production" a
  // two-key action means it can never be turned on by a single misconfigured env.
  if (isProductionEnv()) {
    const allow = (process.env.DEMO_MODE_ALLOW_IN_PRODUCTION ?? "").trim().toLowerCase();
    if (!DEMO_AFFIRMATIVE.includes(allow)) return false;
  }
  return true;
}

/** Resolve a seeded demo user for the tenant+role chosen in the review bar. */
export async function getDemoUser(req: VercelRequest): Promise<SessionUser | null> {
  if (!demoModeEnabled()) return null;

  const headerTenant = (req.headers["x-demo-tenant"] as string | undefined)?.trim();
  const headerRole = (req.headers["x-demo-role"] as string | undefined)?.trim();
  let tenantSlug = headerTenant || readCookie(req, DEMO_COOKIE_TENANT) || "demo";
  // Never resolve a non-demo (real) tenant slug from a client header/cookie.
  if (!isDemoSlug(tenantSlug)) tenantSlug = "demo";
  let role = (headerRole || readCookie(req, DEMO_COOKIE_ROLE) || "owner") as Role;
  if (!ROLES.includes(role)) role = "owner";

  const pick = async (slug: string, r: Role | null) => {
    const { rows } = await query<any>(
      `SELECT u.id, u.tenant_id, u.name, u.email, u.role, u.salesperson_id,
              t.slug AS tenant_slug, t.name AS tenant_name
         FROM users u JOIN tenants t ON t.id = u.tenant_id
        WHERE t.slug = $1 ${r ? "AND u.role = $2" : ""}
        ORDER BY u.created_at ASC LIMIT 1`,
      r ? [slug, r] : [slug],
    );
    return rows[0] ?? null;
  };

  // Preferred (tenant, role); then any user of that tenant; then the demo tenant.
  const row = (await pick(tenantSlug, role)) ?? (await pick(tenantSlug, null)) ?? (await pick("demo", null));
  if (!row) return null;

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

export function setSessionCookie(
  res: VercelResponse,
  token: string,
  opts: { crossSite?: boolean } = {},
): void {
  const maxAge = SESSION_TTL_DAYS * 86400;
  // SameSite=Lax for normal logins. The Kleegr launch may open this app inside
  // an iframe (cross-site), where a Lax cookie would not be sent on subsequent
  // navigations — so the launch flow opts into SameSite=None; Secure, which is
  // also sent on top-level cross-site navigations. None always requires Secure.
  const sameSite = opts.crossSite ? "None" : "Lax";
  res.setHeader("Set-Cookie", [
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=${sameSite}; Secure; Max-Age=${maxAge}`,
  ]);
}

export function clearSessionCookie(res: VercelResponse): void {
  res.setHeader("Set-Cookie", [
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`,
  ]);
}

// ---------------------------------------------------------------------------
// Session TRANSPORT: Authorization: Bearer … first, then the cookie
//
// Mobile WebViews (iOS WebKit, Android WebView) block THIRD-PARTY cookies
// outright. When Smart Productivity frames this app, our own `scm_session`
// cookie is third-party inside that iframe, so it is never stored and never
// sent back — every subsequent request looked unauthenticated and the user was
// bounced to the manual login screen even though the launch had succeeded.
//
// The fix is a second transport that a WebView cannot block: the Kleegr launch
// hands the session token to the framed document (see api/kleegr/launch.ts),
// which keeps it in localStorage — FIRST-party to this origin, iframe or not —
// and replays it as `Authorization: Bearer <token>` on every /api call.
//
// Both transports carry the SAME opaque session token and are validated by the
// exact same `sessions` row lookup, so a Bearer session is neither more nor
// less privileged than a cookie session. Candidates are tried in order and the
// first one that resolves to a live session wins, so a stale Bearer token can
// never shadow a valid cookie (and vice versa).
// ---------------------------------------------------------------------------

/** The raw token from `Authorization: Bearer <token>`, if present. */
export function readBearerToken(req: VercelRequest): string | null {
  const header = req.headers.authorization;
  if (!header || typeof header !== "string") return null;
  if (!header.toLowerCase().startsWith("bearer ")) return null;
  const token = header.slice(7).trim();
  return token || null;
}

/**
 * Every session token this request offers, most specific first:
 * the Bearer header (the embedded/mobile transport), then the cookie.
 * Deduplicated, so the common case costs a single lookup.
 */
export function getSessionTokens(req: VercelRequest): string[] {
  const tokens: string[] = [];
  const bearer = readBearerToken(req);
  if (bearer) tokens.push(bearer);
  const cookie = readCookie(req);
  if (cookie && cookie !== bearer) tokens.push(cookie);
  return tokens;
}

/** The primary session token for this request (Bearer header, else cookie). */
export function getSessionToken(req: VercelRequest): string | null {
  return getSessionTokens(req)[0] ?? null;
}

/**
 * Did the caller declare itself EMBEDDED (running inside the Kleegr/GHL
 * iframe)? Only such a client is handed the raw session token in a login
 * response, because only such a client cannot rely on the cookie: inside a
 * mobile WebView our `scm_session` cookie is third-party and is dropped.
 *
 * A plain browser login stays cookie-only — the token never reaches JS there,
 * so the httpOnly protection is preserved for the standalone web app.
 *
 * Pure (value in, boolean out) so the rule is unit-testable — see auth.test.ts.
 */
export function isEmbeddedClient(value: unknown): boolean {
  return value === true || value === "true" || value === "1" || value === 1;
}

// ---------------------------------------------------------------------------
// Resolve the current user from the request (the auth gate)
// ---------------------------------------------------------------------------

export async function getSessionUser(req: VercelRequest): Promise<SessionUser | null> {
  const real = await getRealSessionUser(req);
  if (real) return real;
  // No valid password session — fall back to the review-mode demo user (or
  // null when demo mode is disabled, which keeps the login wall in place).
  return getDemoUser(req);
}

/** Look one raw session token up in `sessions`. Expired rows are swept. */
export async function getSessionUserForToken(token: string): Promise<SessionUser | null> {
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

/**
 * The real, session-backed lookup (no demo fallback). Tries the Bearer header
 * then the cookie; an unusable candidate (expired, revoked, or — on
 * /api/kleegr/sync — a Kleegr launch token that is not one of ours at all)
 * simply falls through to the next one.
 */
export async function getRealSessionUser(req: VercelRequest): Promise<SessionUser | null> {
  for (const token of getSessionTokens(req)) {
    const user = await getSessionUserForToken(token);
    if (user) return user;
  }
  return null;
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
