// ============================================================================
// AUTH SEED  (idempotent, per-tenant)
//
// Creates one user per role for every tenant, with a hashed demo password, and
// wires up the relationships the role-based portals need:
//   - salesperson / affiliate / partner users are linked to a matching
//     salespeople row (users.salesperson_id) so their portal shows only their
//     own clients/commissions/payouts.
//   - the sales_manager user "owns" the tenant's sales reps via
//     salespeople.manager_user_id, so the manager portal shows their team.
//
// Safe to run repeatedly: every write is an upsert / conditional update, and
// passwords are only (re)set when missing, so it never clobbers a changed one.
//
// NOTE: these are DEMO credentials, intentionally documented in the handoff.
// Rotate / disable them before any real production use.
// ============================================================================

import { query } from "./db.js";
import { hashPassword } from "./auth.js";
import { listTenants } from "./repository.js";

export const DEMO_PASSWORD = "demo1234";

interface SeedUserSpec {
  role: string;
  emailLocal: string;
  nameSuffix: string;
  /** which salespeople.role to link this user to (self-scoped portals) */
  linkSalespersonRole?: "salesperson" | "affiliate" | "partner";
}

const USER_SPECS: SeedUserSpec[] = [
  { role: "owner", emailLocal: "owner", nameSuffix: "Owner" },
  { role: "admin", emailLocal: "admin", nameSuffix: "Admin" },
  { role: "sales_manager", emailLocal: "manager", nameSuffix: "Sales Manager" },
  { role: "salesperson", emailLocal: "rep", nameSuffix: "Sales Rep", linkSalespersonRole: "salesperson" },
  { role: "affiliate", emailLocal: "affiliate", nameSuffix: "Affiliate", linkSalespersonRole: "affiliate" },
  { role: "partner", emailLocal: "partner", nameSuffix: "Partner", linkSalespersonRole: "partner" },
];

async function firstSalespersonId(tenantId: string, role: string): Promise<string | null> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM salespeople
      WHERE tenant_id = $1 AND role = $2 AND approval_status = 'approved'
      ORDER BY created_at ASC LIMIT 1`,
    [tenantId, role],
  );
  return rows[0]?.id ?? null;
}

/** Ensure all role users exist (with passwords) for every tenant. */
export async function ensureAuthSeed(): Promise<void> {
  const tenants = await listTenants();
  const pwHash = hashPassword(DEMO_PASSWORD);

  for (const t of tenants) {
    let managerUserId: string | null = null;

    for (const spec of USER_SPECS) {
      const userId = `user_${spec.role}_${t.slug}`;
      const email = `${spec.emailLocal}@${t.slug}.example.com`;
      const name = `${t.name} ${spec.nameSuffix}`;
      const salespersonId = spec.linkSalespersonRole
        ? await firstSalespersonId(t.id, spec.linkSalespersonRole)
        : null;

      // Upsert the user. Only set the password when it is currently missing so
      // a rotated password is never overwritten by reseeding.
      await query(
        `INSERT INTO users (id, tenant_id, name, email, role, status, salesperson_id, password_hash, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'active',$6,$7, now(), now())
         ON CONFLICT (tenant_id, email) DO UPDATE
           SET role           = EXCLUDED.role,
               salesperson_id = COALESCE(EXCLUDED.salesperson_id, users.salesperson_id),
               password_hash  = COALESCE(users.password_hash, EXCLUDED.password_hash),
               updated_at     = now()`,
        [userId, t.id, name, email, spec.role, salespersonId, pwHash],
      );

      if (spec.role === "sales_manager") {
        const { rows } = await query<{ id: string }>(
          `SELECT id FROM users WHERE tenant_id = $1 AND email = $2`,
          [t.id, email],
        );
        managerUserId = rows[0]?.id ?? userId;
      }
    }

    // Assign the tenant's sales reps to the manager so the manager portal has a
    // team. Only (re)assign reps that don't already have a manager.
    if (managerUserId) {
      await query(
        `UPDATE salespeople
            SET manager_user_id = $1
          WHERE tenant_id = $2 AND role = 'salesperson' AND manager_user_id IS NULL`,
        [managerUserId, t.id],
      );
    }
  }
}
