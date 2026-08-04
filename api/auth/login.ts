// POST /api/auth/login   { email, password, tenant?, embedded? }
// Verifies credentials, opens a server session, sets the httpOnly cookie.
//
// EMBEDDED CLIENTS additionally get the raw session token back in the response
// body. Inside the Kleegr/GHL iframe on a phone, the cookie this endpoint sets
// is THIRD-PARTY and iOS WebKit / Android WebView drop it, so a login there
// used to leave the app with no usable credential at all: the shell mounted
// off the response body while every later /api call was unauthenticated. The
// Kleegr *launch* already solves this by handing the token to localStorage
// (see _lib/launch-handoff.ts); a manual login needs the same handoff.
// See the transport notes in _lib/auth.ts.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { hasDb, query } from "../_lib/db.js";
import { ensureSchema, seedIfEmpty } from "../_lib/repository.js";
import {
  verifyPassword,
  createSession,
  setSessionCookie,
  pruneSessions,
  demoModeEnabled,
  isEmbeddedClient,
  type Role,
} from "../_lib/auth.js";
import { DEMO_PASSWORD } from "../_lib/auth-seed.js";
import { clientIp } from "../_lib/http.js";
import { loginBlocked, recordLoginAttempt, LOGIN_WINDOW_MIN } from "../_lib/rate-limit.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!hasDb()) return res.status(503).json({ error: "database_not_configured" });
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  try {
    await ensureSchema();
    // Only plant the seeded demo tenants/users when demo/review mode is
    // explicitly enabled. In production (demo mode OFF, the default) an empty
    // database is NOT auto-populated with demo data on a login attempt, so the
    // seeded demo tenants stay absent/unreachable. Real sub-accounts arrive via
    // the Kleegr launch flow (which provisions its own tenant/user).
    if (demoModeEnabled()) await seedIfEmpty();
    await pruneSessions();

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body ?? {};
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    const tenant = body.tenant ? String(body.tenant).trim() : null;
    // Set by the client when it is running framed (see src/lib/useEmbedded.ts).
    const embedded = isEmbeddedClient(body.embedded);

    if (!email || !password) {
      return res.status(400).json({ error: "missing_credentials" });
    }

    // Brute-force throttling (fail-open on any DB error): after too many recent
    // failed attempts for this IP or email, reject with 429 until the window passes.
    const ip = clientIp(req);
    if (await loginBlocked(ip, email)) {
      res.setHeader("Retry-After", String(LOGIN_WINDOW_MIN * 60));
      return res.status(429).json({ error: "too_many_attempts" });
    }

    // Defense-in-depth: with demo mode OFF (the default), the well-known seeded
    // demo password must NEVER authenticate — even against a database that was
    // previously seeded with it. This makes `demo1234` logins dead by default
    // without requiring a re-seed or manual DB surgery. It never blocks a real,
    // rotated password (no production account should carry the documented demo
    // credential). The generic error avoids revealing the policy.
    if (!demoModeEnabled() && password === DEMO_PASSWORD) {
      await recordLoginAttempt(ip, email, false);
      return res.status(401).json({ error: "invalid_credentials" });
    }

    const { rows } = await query<any>(
      `SELECT u.id, u.tenant_id, u.name, u.email, u.role, u.salesperson_id, u.password_hash,
              u.status, t.slug AS tenant_slug, t.name AS tenant_name
         FROM users u JOIN tenants t ON t.id = u.tenant_id
        WHERE lower(u.email) = $1 ${tenant ? "AND t.slug = $2" : ""}`,
      tenant ? [email, tenant] : [email],
    );

    if (rows.length > 1 && !tenant) {
      // same email in multiple tenants — ask which one
      return res.status(409).json({
        error: "tenant_required",
        tenants: rows.map((r) => ({ slug: r.tenant_slug, name: r.tenant_name })),
      });
    }

    const user = rows[0];
    // Constant-ish failure path; verifyPassword on a missing hash returns false.
    if (!user || user.status !== "active" || !verifyPassword(password, user.password_hash)) {
      await recordLoginAttempt(ip, email, false);
      return res.status(401).json({ error: "invalid_credentials" });
    }

    const token = await createSession(user.id, user.tenant_id);
    // A framed login needs SameSite=None so the cookie is at least *eligible*
    // to be sent cross-site (desktop embeds, where third-party cookies are
    // still allowed, keep working off it). Where the WebView blocks it anyway,
    // the token below is what carries the session.
    setSessionCookie(res, token, { crossSite: embedded });
    await recordLoginAttempt(ip, email, true);
    await query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);

    return res.status(200).json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role as Role,
        tenantSlug: user.tenant_slug,
        tenantName: user.tenant_name,
        salespersonId: user.salesperson_id ?? null,
      },
      // Embedded clients ONLY. A standalone browser login is unchanged and
      // never sees the token, so it stays httpOnly-cookie-only there.
      ...(embedded ? { token } : {}),
    });
  } catch (err) {
    console.error("[scm:error] login:", err instanceof Error ? (err.stack ?? err.message) : String(err));
    return res.status(500).json({ error: "internal_error" });
  }
}
