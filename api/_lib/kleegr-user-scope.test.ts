// Regression tests for the SCM launch crash:
//   `duplicate key value violates unique constraint "users_pkey"`
//
// Run via `tsx api/_lib/kleegr-user-scope.test.ts` (wired into `npm test`).
//
// The same GoHighLevel user is routinely a member of SEVERAL sub-accounts.
// SCM used to mint local user ids as `user_k_<sp_user_id>` — unique per GHL
// user, but NOT per tenant — so the SECOND sub-account launch tried to INSERT
// a users row whose primary key was already owned by the first tenant.
//
// These tests drive the real `upsertUserForClaims` against an in-memory fake
// DB that enforces the actual constraints (`users` PRIMARY KEY (id) and
// UNIQUE (tenant_id, email)) and throws the exact Postgres error message. No
// Neon connection, no production data, no Smart Productivity involvement.
//
// Expected ids are pinned LITERALLY rather than via buildKleegrUserId, so the
// suite fails loudly if the id scheme is ever reverted to the global shape.

import {
  upsertUserForClaims,
  buildKleegrUserId,
  legacyKleegrUserId,
  type QueryFn,
} from "./kleegr-sync.js";
import type { LaunchClaims, AppRole } from "./kleegr.js";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    console.log(`  \u2717 ${name}`);
  }
}

// ---------------------------------------------------------------------------
// In-memory `users` table with the real constraints
// ---------------------------------------------------------------------------

interface FakeUserRow {
  id: string;
  tenant_id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  salesperson_id: string | null;
  kleegr_user_id: string | null;
  kleegr_role: string | null;
  kleegr_permissions: string;
}

const PKEY_ERROR = 'duplicate key value violates unique constraint "users_pkey"';

class FakeUsersDb {
  rows: FakeUserRow[] = [];
  inserts = 0;

  seed(row: Partial<FakeUserRow> & { id: string; tenant_id: string; email: string }): FakeUserRow {
    const full: FakeUserRow = {
      name: "seeded",
      role: "salesperson",
      status: "active",
      salesperson_id: null,
      kleegr_user_id: null,
      kleegr_role: null,
      kleegr_permissions: "[]",
      ...row,
    };
    this.rows.push(full);
    return full;
  }

  byId(id: string): FakeUserRow | undefined {
    return this.rows.find((r) => r.id === id);
  }

  forTenant(tenantId: string): FakeUserRow[] {
    return this.rows.filter((r) => r.tenant_id === tenantId);
  }

  query: QueryFn = async <T = any>(text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim();
    const p = params as any[];
    const wrap = (rows: any[]) => ({ rows: rows as T[], rowCount: rows.length });

    if (sql.startsWith("SELECT") && sql.includes("FROM users")) {
      if (sql.includes("kleegr_user_id = $2")) {
        return wrap(this.rows.filter((r) => r.tenant_id === p[0] && r.kleegr_user_id === p[1]).slice(0, 1));
      }
      if (sql.includes("lower(email) = $2")) {
        return wrap(
          this.rows.filter((r) => r.tenant_id === p[0] && r.email.toLowerCase() === String(p[1]).toLowerCase()).slice(0, 1),
        );
      }
      if (sql.includes("WHERE id = $1")) {
        return wrap(this.rows.filter((r) => r.id === p[0]).slice(0, 1));
      }
      throw new Error(`fake db: unhandled SELECT — ${sql}`);
    }

    if (sql.startsWith("UPDATE users SET")) {
      const target = this.byId(String(p[0]));
      if (target) {
        if (sql.includes("kleegr_user_id = $2")) target.kleegr_user_id = p[1] ?? null;
        if (sql.includes("role = $2")) target.role = String(p[1]);
        if (sql.includes("role = $5")) target.role = String(p[4]);
        if (sql.includes("email = CASE WHEN $5") && p[4]) target.email = String(p[4]);
      }
      return wrap([]);
    }

    if (sql.startsWith("INSERT INTO users")) {
      const [id, tenantId, name, email, role, kleegrUserId, kleegrRole, perms] = p;

      // PRIMARY KEY (id) — the constraint the launch bug used to violate.
      if (this.byId(String(id))) throw new Error(PKEY_ERROR);

      // ON CONFLICT (tenant_id, email) DO UPDATE …
      const conflict = this.rows.find(
        (r) => r.tenant_id === tenantId && r.email.toLowerCase() === String(email).toLowerCase(),
      );
      if (conflict) {
        conflict.kleegr_user_id = kleegrUserId ?? null;
        conflict.kleegr_role = kleegrRole ?? null;
        conflict.kleegr_permissions = String(perms);
        conflict.role = String(role);
        return wrap([]);
      }

      this.rows.push({
        id: String(id),
        tenant_id: String(tenantId),
        name: String(name),
        email: String(email),
        role: String(role),
        status: "active",
        salesperson_id: null,
        kleegr_user_id: kleegrUserId ?? null,
        kleegr_role: kleegrRole ?? null,
        kleegr_permissions: String(perms),
      });
      this.inserts++;
      return wrap([]);
    }

    throw new Error(`fake db: unhandled SQL — ${sql}`);
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Tenant ids exactly as upsertTenantForSubAccount mints them. */
const TENANT_A = "tenant_k_subAccountAlpha";
const TENANT_B = "tenant_k_subAccountBravo";
const SP_USER = "sp_user_1";
const ROLE: AppRole = "admin" as AppRole;

function claims(spUserId: string, email: string | null): LaunchClaims {
  return {
    sp_user_id: spUserId,
    email,
    role: "admin",
    permissions: ["read", "write"],
    sub_account_id: "sub",
    location_id: "loc",
    exp: null,
    raw: {},
  } as unknown as LaunchClaims;
}

async function throws(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return String((e as Error)?.message ?? e);
  }
}

// ---------------------------------------------------------------------------

async function main() {
  // =========================================================================
  console.log("\n[SCM · tenant-scoped user ids (pure)]");
  const idA = buildKleegrUserId(TENANT_A, SP_USER);
  const idB = buildKleegrUserId(TENANT_B, SP_USER);
  ok("id is deterministic", buildKleegrUserId(TENANT_A, SP_USER) === idA);
  ok("id carries the tenant", idA.includes("subAccountAlpha"));
  ok("id carries the Kleegr user", idA.endsWith(SP_USER));
  ok("same GHL user in two tenants → two different ids", idA !== idB);
  ok("new ids are NOT the old global shape", idA !== legacyKleegrUserId(SP_USER));
  ok("unsafe characters are stripped", /^[A-Za-z0-9_-]+$/.test(buildKleegrUserId("tenant_k_a b/c", "sp:1")));

  // =========================================================================
  console.log("\n[SCM · the fake DB really enforces users_pkey]");
  // Sanity check: without this, the two-tenant test below would pass vacuously.
  const guard = new FakeUsersDb();
  const legacyInsert = () =>
    guard.query(
      `INSERT INTO users (id, tenant_id, name, email, role, status, kleegr_user_id, kleegr_role,
        kleegr_permissions, last_login_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8::jsonb, now(), now(), now())
       ON CONFLICT (tenant_id, email) DO UPDATE SET role = EXCLUDED.role`,
      [legacyKleegrUserId(SP_USER), TENANT_A, "n", "rep@example.com", "admin", SP_USER, "admin", "[]"],
    );
  ok("first insert of the legacy id succeeds", (await throws(legacyInsert)) === null);
  ok("re-using the legacy id across tenants raises users_pkey", (await throws(legacyInsert)) === PKEY_ERROR);

  // =========================================================================
  console.log("\n[SCM · same GHL user launches in two sub-accounts]");
  const db = new FakeUsersDb();
  const c = claims(SP_USER, "rep@example.com");

  const first = await upsertUserForClaims(TENANT_A, c, ROLE, db.query);
  ok("first launch creates a user", db.rows.length === 1);
  ok("first launch id is tenant-scoped", first.id === buildKleegrUserId(TENANT_A, SP_USER));

  const secondErr = await throws(() => upsertUserForClaims(TENANT_B, c, ROLE, db.query));
  ok("second launch (other sub-account) does NOT raise users_pkey", secondErr === null);

  const second = await upsertUserForClaims(TENANT_B, claims(SP_USER, "rep@example.com"), ROLE, db.query);
  ok("both tenants now have exactly one user each", db.forTenant(TENANT_A).length === 1 && db.forTenant(TENANT_B).length === 1);
  ok("the two rows have distinct primary keys", first.id !== second.id);
  // Literal (non self-referential) expectations — these fail on the old global scheme.
  ok("tenant A's id is user_k_<tenant>_<sp_user>", first.id === `user_k_${TENANT_A}_${SP_USER}`);
  ok("tenant B's id is user_k_<tenant>_<sp_user>", second.id === `user_k_${TENANT_B}_${SP_USER}`);
  ok("tenant B's row is scoped to tenant B", second.tenant_id === TENANT_B);
  ok("same email in both tenants is fine (unique is per tenant)", db.rows.every((r) => r.email === "rep@example.com"));
  ok("both rows are linked back to the same Kleegr user", db.rows.every((r) => r.kleegr_user_id === SP_USER));

  // idempotent re-launch
  const relaunchA = await upsertUserForClaims(TENANT_A, c, ROLE, db.query);
  const relaunchB = await upsertUserForClaims(TENANT_B, c, ROLE, db.query);
  ok("re-launch in tenant A returns the same row", relaunchA.id === first.id);
  ok("re-launch in tenant B returns the same row", relaunchB.id === second.id);
  ok("re-launches insert nothing new", db.rows.length === 2);

  // =========================================================================
  console.log("\n[SCM · users with no email still work per tenant]");
  const noEmail = new FakeUsersDb();
  const anon = claims("sp_user_2", null);
  const anonA = await upsertUserForClaims(TENANT_A, anon, ROLE, noEmail.query);
  const anonErr = await throws(() => upsertUserForClaims(TENANT_B, anon, ROLE, noEmail.query));
  ok("no-email launch in a second sub-account does not raise users_pkey", anonErr === null);
  ok("two rows, distinct ids", noEmail.rows.length === 2 && noEmail.rows[0].id !== noEmail.rows[1].id);
  ok("first row keeps its tenant-scoped id", anonA.id === `user_k_${TENANT_A}_sp_user_2`);

  // =========================================================================
  console.log("\n[SCM · legacy first-tenant users keep working]");
  const legacyDb = new FakeUsersDb();
  const legacyId = legacyKleegrUserId(SP_USER);
  legacyDb.seed({
    id: legacyId,
    tenant_id: TENANT_A,
    email: "rep@example.com",
    name: "rep",
    role: "salesperson",
    kleegr_user_id: SP_USER,
  });

  const legacyRelaunch = await upsertUserForClaims(TENANT_A, c, ROLE, legacyDb.query);
  ok("legacy row is resolved, not duplicated", legacyDb.rows.length === 1);
  ok("legacy id is preserved (sessions / FKs survive)", legacyRelaunch.id === legacyId);
  ok("legacy row's role is refreshed from the launch claims", legacyDb.byId(legacyId)?.role === ROLE);
  ok("no INSERT was issued for the legacy user", legacyDb.inserts === 0);

  const legacyCrossErr = await throws(() => upsertUserForClaims(TENANT_B, c, ROLE, legacyDb.query));
  ok("that same legacy user can now launch in a second sub-account", legacyCrossErr === null);
  ok("the new row got a tenant-scoped id", !!legacyDb.byId(`user_k_${TENANT_B}_${SP_USER}`));
  ok("the legacy row was left untouched", legacyDb.byId(legacyId)?.tenant_id === TENANT_A);
  ok("exactly two rows exist", legacyDb.rows.length === 2);

  // =========================================================================
  console.log("\n[SCM · existing local (non-Kleegr) user is linked, not duplicated]");
  const localDb = new FakeUsersDb();
  localDb.seed({ id: "user_admin_acme", tenant_id: TENANT_A, email: "rep@example.com", name: "rep", role: "admin" });
  const linked = await upsertUserForClaims(TENANT_A, c, ROLE, localDb.query);
  ok("matched by (tenant_id, email)", linked.id === "user_admin_acme");
  ok("no duplicate row created", localDb.rows.length === 1 && localDb.inserts === 0);
  ok("kleegr_user_id was attached to the existing row", localDb.byId("user_admin_acme")?.kleegr_user_id === SP_USER);

  console.log(`\n========================\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

void main();
