// POST /api/auth/login   { email, password, tenant? }
// Verifies credentials, opens a server session, sets the httpOnly cookie.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { hasDb, query } from "../_lib/db.js";
import { ensureSchema, seedIfEmpty } from "../_lib/repository.js";
import {
  verifyPassword,
  createSession,
  setSessionCookie,
  pruneSessions,
  type Role,
} from "../_lib/auth.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!hasDb()) return res.status(503).json({ error: "database_not_configured" });
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  try {
    await ensureSchema();
    await seedIfEmpty();
    await pruneSessions();

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body ?? {};
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    const tenant = body.tenant ? String(body.tenant).trim() : null;

    if (!email || !password) {
      return res.status(400).json({ error: "missing_credentials" });
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
      return res.status(401).json({ error: "invalid_credentials" });
    }

    const token = await createSession(user.id, user.tenant_id);
    setSessionCookie(res, token);
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
    });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
}
