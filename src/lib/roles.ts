// ============================================================================
// ROLES  (shared client-side role metadata)
//
// Single source of truth for what each role is called, where it lands after
// login, and which routes it may see. The server enforces data scoping; this
// drives navigation + client-side route guards so the UI matches the role.
// ============================================================================

export type Role =
  | "owner"
  | "admin"
  | "sales_manager"
  | "salesperson"
  | "affiliate"
  | "partner";

export const ROLE_LABEL: Record<Role, string> = {
  owner: "Agency Owner",
  admin: "Admin",
  sales_manager: "Sales Manager",
  salesperson: "Salesperson",
  affiliate: "Affiliate",
  partner: "Partner",
};

export const ADMIN_ROLES: Role[] = ["owner", "admin"];
export const SELF_ROLES: Role[] = ["salesperson", "affiliate", "partner"];

/**
 * Where a role lands after login, and where the route guard sends a role that
 * hits a page it may not see.
 *
 *   owner (agency owner / super admin) -> the AGENCY portal: the cross-sub-account
 *     overview is the agency owner's home/"dashboard". The single-sub-account
 *     Dashboard at "/" is the sub-account Admin's home, NOT the agency owner's,
 *     which is why the owner is intentionally not granted "/" below — landing
 *     there made the agency owner look like an ordinary sub-account user and hid
 *     the agency/sub-account overview entirely.
 *   admin / sales_manager -> the single-sub-account Dashboard.
 *   salesperson / affiliate / partner -> their self-service portal.
 */
export function homePath(role: Role): string {
  if (role === "owner") return "/agency";
  if (role === "admin" || role === "sales_manager") return "/";
  return "/portal";
}

// Which roles may visit each top-level route. Detail routes inherit from their
// parent (handled in canAccess by prefix match).
//
// NOTE: "/" (the single-sub-account Dashboard) is the Admin's / Manager's home.
// The agency owner's home is "/agency"; the owner reaches an individual
// sub-account dashboard by opening that sub-account's workspace (which drops
// into the admin product for that tenant). Keeping the owner off "/" lets the
// guard redirect owner -> /agency cleanly and hides the redundant Dashboard
// nav item for the agency role.
const ACCESS: Array<{ path: string; roles: Role[] }> = [
  { path: "/", roles: ["admin", "sales_manager"] },
  { path: "/agency", roles: ["owner", "admin"] },
  { path: "/people", roles: ["owner", "admin"] },
  { path: "/plans", roles: ["owner", "admin"] },
  { path: "/clients", roles: ["owner", "admin", "sales_manager"] },
  { path: "/payments", roles: ["owner", "admin"] },
  { path: "/ledger", roles: ["owner", "admin", "sales_manager"] },
  { path: "/payouts", roles: ["owner", "admin", "sales_manager", "salesperson", "affiliate", "partner"] },
  { path: "/reports", roles: ["owner", "admin", "sales_manager"] },
  { path: "/goals", roles: ["owner", "admin", "sales_manager"] },
  { path: "/documents", roles: ["owner", "admin", "sales_manager", "salesperson", "affiliate", "partner"] },
  { path: "/portal", roles: ["salesperson", "affiliate", "partner"] },
  { path: "/present", roles: ["owner", "admin"] },
  { path: "/settings", roles: ["owner", "admin"] },
];

export function canAccess(role: Role, path: string): boolean {
  // longest matching prefix wins (so /plans/new inherits /plans)
  let match: Role[] | null = null;
  let bestLen = -1;
  for (const rule of ACCESS) {
    const isMatch = path === rule.path || path.startsWith(rule.path + "/");
    if (isMatch && rule.path.length > bestLen) {
      match = rule.roles;
      bestLen = rule.path.length;
    }
  }
  return match ? match.includes(role) : false;
}
