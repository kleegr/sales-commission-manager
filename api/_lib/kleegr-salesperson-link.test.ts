// Regression tests for the reported Kleegr launch defect:
//   "Salesperson portal — No profile found.
//    This account isn't linked to a salesperson record yet."
//
// Run via `tsx api/_lib/kleegr-salesperson-link.test.ts` (wired into `npm test`).
//
// THE DEFECT
// ----------
// A Kleegr launch created the `users` row (upsertUserForClaims) and stopped
// there, so `users.salesperson_id` was NULL for every launched user. For a
// self-scoped role that is the entire workspace:
//
//   launch.ts   homePathFor('salesperson')          -> /portal
//   state.ts    readScopedState({ salespersonId })
//   repository.ts:413  visibleSp = salespersonId ? {id} : {}   <- EMPTY
//               filterAppData(full, {})              -> salespeople: []
//   SalespersonPortal.tsx:65  data.salespeople[0]    -> undefined
//   SalespersonPortal.tsx:174 -> "No profile found"
//
// So it reproduced on EVERY launch, not merely the first — it was never an
// unlucky-first-run problem.
//
// These tests drive the REAL upsertUserForClaims + ensureSalespersonForUser
// against an in-memory fake DB holding `users` and `salespeople`. No Neon
// connection, no production data, no Smart Productivity involvement.
//
// `portalScope()` below reproduces repository.ts:413 verbatim, so the assertion
// that the portal is non-empty is a statement about the real filter, not about
// a convenient stand-in.

import {
  upsertUserForClaims,
  ensureSalespersonForUser,
  buildKleegrSalespersonId,
  isSelfScopedRole,
  type QueryFn,
} from "./kleegr-sync.js";
import type { LaunchClaims, AppRole } from "./kleegr.js";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}`);
  }
}

// ---------------------------------------------------------------------------
// In-memory `users` + `salespeople`
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

interface FakeSpRow {
  id: string;
  tenant_id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  approval_status: string;
  source: string;
  kleegr_user_id: string | null;
  created_at: string;
  updated_at: string;
}

class FakeDb {
  users: FakeUserRow[] = [];
  salespeople: FakeSpRow[] = [];
  spInserts = 0;

  seedUser(row: Partial<FakeUserRow> & { id: string; tenant_id: string; email: string }): FakeUserRow {
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
    this.users.push(full);
    return full;
  }

  seedSp(row: Partial<FakeSpRow> & { id: string; tenant_id: string; email: string }): FakeSpRow {
    const full: FakeSpRow = {
      name: "seeded rep",
      role: "salesperson",
      status: "active",
      approval_status: "approved",
      source: "admin",
      kleegr_user_id: null,
      created_at: "2020-01-01T00:00:00.000Z",
      updated_at: "2020-01-01T00:00:00.000Z",
      ...row,
    };
    this.salespeople.push(full);
    return full;
  }

  userById(id: string): FakeUserRow | undefined {
    return this.users.find((r) => r.id === id);
  }
  spById(id: string): FakeSpRow | undefined {
    return this.salespeople.find((r) => r.id === id);
  }

  query: QueryFn = async <T = any>(text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim();
    const p = params as any[];
    const wrap = (rows: any[]) => ({ rows: rows as T[], rowCount: rows.length });

    // ---- salespeople -------------------------------------------------------
    if (sql.startsWith("SELECT") && sql.includes("FROM salespeople")) {
      if (sql.includes("kleegr_user_id = $2")) {
        return wrap(this.salespeople.filter((r) => r.tenant_id === p[0] && r.kleegr_user_id === p[1]).slice(0, 1));
      }
      if (sql.includes("lower(email) = $2")) {
        return wrap(
          this.salespeople
            .filter((r) => r.tenant_id === p[0] && r.email.toLowerCase() === String(p[1]).toLowerCase())
            .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
            .slice(0, 1),
        );
      }
      throw new Error(`fake db: unhandled salespeople SELECT — ${sql}`);
    }

    if (sql.startsWith("UPDATE salespeople SET")) {
      const target = this.spById(String(p[0]));
      if (target && sql.includes("kleegr_user_id = COALESCE")) {
        target.kleegr_user_id = target.kleegr_user_id ?? (p[1] ?? null);
        target.updated_at = String(p[2]);
      }
      return wrap([]);
    }

    if (sql.startsWith("INSERT INTO salespeople")) {
      const [id, tenantId, name, email, role, kleegrUserId, ts] = p;
      const existing = this.spById(String(id));
      if (existing) {
        existing.kleegr_user_id = existing.kleegr_user_id ?? (kleegrUserId ?? null);
        existing.updated_at = String(ts);
        return wrap([]);
      }
      this.salespeople.push({
        id: String(id),
        tenant_id: String(tenantId),
        name: String(name),
        email: String(email),
        role: String(role),
        status: "active",
        approval_status: "approved",
        source: "admin",
        kleegr_user_id: kleegrUserId ?? null,
        created_at: String(ts),
        updated_at: String(ts),
      });
      this.spInserts++;
      return wrap([]);
    }

    // ---- users -------------------------------------------------------------
    if (sql.startsWith("SELECT") && sql.includes("FROM users")) {
      if (sql.includes("kleegr_user_id = $2")) {
        return wrap(this.users.filter((r) => r.tenant_id === p[0] && r.kleegr_user_id === p[1]).slice(0, 1));
      }
      if (sql.includes("lower(email) = $2")) {
        return wrap(
          this.users.filter((r) => r.tenant_id === p[0] && r.email.toLowerCase() === String(p[1]).toLowerCase()).slice(0, 1),
        );
      }
      if (sql.includes("WHERE id = $1")) {
        return wrap(this.users.filter((r) => r.id === p[0]).slice(0, 1));
      }
      throw new Error(`fake db: unhandled users SELECT — ${sql}`);
    }

    if (sql.startsWith("UPDATE users SET")) {
      const target = this.userById(String(p[0]));
      if (target) {
        // the link written by ensureSalespersonForUser
        if (sql.includes("SET salesperson_id = COALESCE")) {
          target.salesperson_id = target.salesperson_id ?? (p[1] ?? null);
          return wrap([]);
        }
        if (sql.includes("kleegr_user_id = $2")) target.kleegr_user_id = p[1] ?? null;
        if (sql.includes("role = $2")) target.role = String(p[1]);
        if (sql.includes("role = $5")) target.role = String(p[4]);
        if (sql.includes("email = CASE WHEN $5") && p[4]) target.email = String(p[4]);
      }
      return wrap([]);
    }

    if (sql.startsWith("INSERT INTO users")) {
      const [id, tenantId, name, email, role, kleegrUserId, kleegrRole, perms] = p;
      const conflict = this.users.find(
        (r) => r.tenant_id === tenantId && r.email.toLowerCase() === String(email).toLowerCase(),
      );
      if (conflict) {
        conflict.kleegr_user_id = kleegrUserId ?? null;
        conflict.kleegr_role = kleegrRole ?? null;
        conflict.kleegr_permissions = String(perms);
        conflict.role = String(role);
        return wrap([]);
      }
      this.users.push({
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
      return wrap([]);
    }

    throw new Error(`fake db: unhandled SQL — ${sql}`);
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT_A = "tenant_k_subAccountAlpha";
const TENANT_B = "tenant_k_subAccountBravo";
const SP_USER = "sp_user_1";

function claims(spUserId: string, email: string | null): LaunchClaims {
  return {
    sp_user_id: spUserId,
    email,
    role: "user",
    permissions: ["view_commissions", "view_reports"],
    sub_account_id: "sub",
    location_id: "loc",
    exp: null,
    raw: {},
  } as unknown as LaunchClaims;
}

/**
 * repository.ts:413 verbatim — the scope a non-admin, non-manager role gets.
 * An empty set is exactly what made the portal render "No profile found".
 */
function portalScope(salespersonId: string | null): Set<string> {
  return new Set(salespersonId ? [salespersonId] : []);
}

/** Run the real launch sequence: upsert the user, then ensure the rep link. */
async function launch(db: FakeDb, tenantId: string, c: LaunchClaims, role: AppRole) {
  const user = await upsertUserForClaims(tenantId, c, role, db.query);
  const link = await ensureSalespersonForUser(tenantId, user, c, role, db.query);
  return { user, link };
}

// ---------------------------------------------------------------------------

async function main() {
  // =========================================================================
  console.log("\n[SCM · which roles are rep-scoped]");
  ok("salesperson is self-scoped", isSelfScopedRole("salesperson"));
  ok("affiliate is self-scoped", isSelfScopedRole("affiliate"));
  ok("partner is self-scoped", isSelfScopedRole("partner"));
  ok("admin is NOT self-scoped", !isSelfScopedRole("admin"));
  ok("owner is NOT self-scoped", !isSelfScopedRole("owner"));
  ok("sales_manager is NOT self-scoped (team-scoped via manager_user_id)", !isSelfScopedRole("sales_manager"));

  // =========================================================================
  console.log("\n[SCM · the reported defect: first launch of a salesperson]");
  const db = new FakeDb();
  const c = claims(SP_USER, "rep@example.com");
  const { user, link } = await launch(db, TENANT_A, c, "salesperson" as AppRole);

  ok("a salespeople row now exists", db.salespeople.length === 1);
  ok("the launch reports it as created", link.outcome === "created");
  ok("the rep id is tenant-scoped", link.salespersonId === buildKleegrSalespersonId(TENANT_A, SP_USER));
  ok("users.salesperson_id is linked", db.userById(user.id)?.salesperson_id === link.salespersonId);
  ok("the rep carries the Kleegr user id", db.spById(link.salespersonId!)?.kleegr_user_id === SP_USER);
  ok("the rep carries the launch email", db.spById(link.salespersonId!)?.email === "rep@example.com");
  ok("the rep role matches the mapped SCM role", db.spById(link.salespersonId!)?.role === "salesperson");
  ok("source stays inside the documented union", db.spById(link.salespersonId!)?.source === "admin");
  ok("the rep is immediately usable (active + approved)",
    db.spById(link.salespersonId!)?.status === "active" && db.spById(link.salespersonId!)?.approval_status === "approved");

  // THE assertion: the portal's own scope is no longer empty.
  const scope = portalScope(db.userById(user.id)?.salesperson_id ?? null);
  ok("portal scope is non-empty -> SalespersonPortal renders a profile", scope.size === 1);
  ok("portal scope contains exactly this rep", scope.has(link.salespersonId!));

  // Proof the test would have caught the bug: the pre-fix state is NULL.
  ok("an unlinked user still yields the empty scope (pre-fix behaviour)", portalScope(null).size === 0);

  // =========================================================================
  console.log("\n[SCM · re-launch is idempotent]");
  const again = await launch(db, TENANT_A, c, "salesperson" as AppRole);
  ok("no second rep row", db.salespeople.length === 1);
  ok("no second INSERT", db.spInserts === 1);
  ok("the same rep is reported", again.link.salespersonId === link.salespersonId);
  ok("re-launch reports it as already linked", again.link.outcome === "already_linked");

  // =========================================================================
  console.log("\n[SCM · an existing manually-entered rep is ADOPTED, not duplicated]");
  const adopt = new FakeDb();
  adopt.seedSp({ id: "sp_manual_1", tenant_id: TENANT_A, email: "Rep@Example.com", name: "Manually Added Rep" });
  const adopted = await launch(adopt, TENANT_A, claims(SP_USER, "rep@example.com"), "salesperson" as AppRole);
  ok("matched the existing rep by email (case-insensitive)", adopted.link.salespersonId === "sp_manual_1");
  ok("reported as matched_by_email", adopted.link.outcome === "matched_by_email");
  ok("no new rep was created", adopt.salespeople.length === 1 && adopt.spInserts === 0);
  ok("the existing rep keeps its own name (not overwritten)", adopt.spById("sp_manual_1")?.name === "Manually Added Rep");
  ok("kleegr_user_id was stamped onto it", adopt.spById("sp_manual_1")?.kleegr_user_id === SP_USER);
  ok("the user is linked to the adopted rep", adopt.userById(adopted.user.id)?.salesperson_id === "sp_manual_1");

  // =========================================================================
  console.log("\n[SCM · a rep already imported for this Kleegr user is reused]");
  const byK = new FakeDb();
  byK.seedSp({ id: "sp_imported_1", tenant_id: TENANT_A, email: "other@example.com", kleegr_user_id: SP_USER });
  const reused = await launch(byK, TENANT_A, claims(SP_USER, "rep@example.com"), "salesperson" as AppRole);
  ok("matched by kleegr_user_id, not email", reused.link.salespersonId === "sp_imported_1");
  ok("reported as matched_by_kleegr_user", reused.link.outcome === "matched_by_kleegr_user");
  ok("no new rep was created", byK.salespeople.length === 1 && byK.spInserts === 0);

  // =========================================================================
  console.log("\n[SCM · an existing link is never re-pointed]");
  const pinned = new FakeDb();
  pinned.seedUser({
    id: "user_local_1",
    tenant_id: TENANT_A,
    email: "rep@example.com",
    role: "salesperson",
    salesperson_id: "sp_chosen_by_admin",
  });
  pinned.seedSp({ id: "sp_chosen_by_admin", tenant_id: TENANT_A, email: "rep@example.com" });
  const kept = await launch(pinned, TENANT_A, claims(SP_USER, "rep@example.com"), "salesperson" as AppRole);
  ok("the admin's chosen rep is preserved", kept.link.salespersonId === "sp_chosen_by_admin");
  ok("reported as already_linked", kept.link.outcome === "already_linked");
  ok("no rep row was invented", pinned.salespeople.length === 1 && pinned.spInserts === 0);

  // =========================================================================
  console.log("\n[SCM · non-rep roles are left alone]");
  for (const role of ["admin", "owner", "sales_manager"] as AppRole[]) {
    const skip = new FakeDb();
    const r = await launch(skip, TENANT_A, claims(SP_USER, "boss@example.com"), role);
    ok(`${role}: no salespeople row is created`, skip.salespeople.length === 0);
    ok(`${role}: reported as skipped`, r.link.outcome === "skipped_not_self_scoped");
    ok(`${role}: users.salesperson_id stays NULL`, skip.userById(r.user.id)?.salesperson_id === null);
  }

  // =========================================================================
  console.log("\n[SCM · affiliate and partner get their own rep record]");
  for (const role of ["affiliate", "partner"] as AppRole[]) {
    const alt = new FakeDb();
    const r = await launch(alt, TENANT_A, claims(`${SP_USER}_${role}`, `${role}@example.com`), role);
    ok(`${role}: a rep row is created`, alt.salespeople.length === 1);
    ok(`${role}: the rep role matches`, alt.spById(r.link.salespersonId!)?.role === role);
    ok(`${role}: portal scope is non-empty`, portalScope(alt.userById(r.user.id)?.salesperson_id ?? null).size === 1);
  }

  // =========================================================================
  console.log("\n[SCM · the same GHL user in two sub-accounts gets two reps]");
  const multi = new FakeDb();
  const a = await launch(multi, TENANT_A, claims(SP_USER, "rep@example.com"), "salesperson" as AppRole);
  const b = await launch(multi, TENANT_B, claims(SP_USER, "rep@example.com"), "salesperson" as AppRole);
  ok("two rep rows exist", multi.salespeople.length === 2);
  ok("the rep ids are distinct", a.link.salespersonId !== b.link.salespersonId);
  ok("each rep is scoped to its own tenant",
    multi.spById(a.link.salespersonId!)?.tenant_id === TENANT_A &&
    multi.spById(b.link.salespersonId!)?.tenant_id === TENANT_B);
  ok("each user row points at its own tenant's rep",
    multi.userById(a.user.id)?.salesperson_id === a.link.salespersonId &&
    multi.userById(b.user.id)?.salesperson_id === b.link.salespersonId);

  // =========================================================================
  console.log("\n[SCM · a launch with no email still gets a portal]");
  const anon = new FakeDb();
  const r = await launch(anon, TENANT_A, claims("sp_user_no_email", null), "salesperson" as AppRole);
  ok("a rep row is still created", anon.salespeople.length === 1);
  ok("the rep is linked", anon.userById(r.user.id)?.salesperson_id === r.link.salespersonId);
  ok("portal scope is non-empty", portalScope(anon.userById(r.user.id)?.salesperson_id ?? null).size === 1);
  ok("the empty email did not match some other rep", r.link.outcome === "created");

  console.log(`\n========================\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

void main();
