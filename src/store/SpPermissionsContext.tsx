// ============================================================================
// SMART PRODUCTIVITY PERMISSIONS CONTEXT  (client)
//
// Sales Commission Manager can be launched embedded inside a Kleegr / Smart
// Productivity (SP) sub-account. When that happens the SP launch flow fetches
// the sub-account's per-plugin permission policy SERVER-side (using the launch
// token, which never reaches the browser) and hands it to the client through
// the same localStorage handoff that carries the session token — the SP policy
// blob is written to localStorage['scm_sp_perms']. See api/kleegr/launch.ts and
// api/_lib/launch-handoff.ts.
//
// This provider reads that blob ONCE at mount and gates the UI accordingly:
//   - canManagePlans      → New plan / plan editing entry points
//   - canApprovePayouts   → the payout Approve action (AND-ed with the role gate)
//   - canExportReports    → the CSV / report export buttons
//   - maxPlans            → cap on the number of commission plans
//
// STANDALONE-SAFE: when the app is NOT launched from SP there is no blob, and
// this provider reports `embedded === false`, every `can()` returns `true`, and
// `maxPlans()` returns `null` (unlimited) — byte-for-byte the pre-existing
// behavior. FAILS OPEN: a malformed blob, an absent key, or a null policy all
// resolve to "allowed"/"unlimited" so a transient hiccup never blocks a user.
// ============================================================================

import {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from "react";

/** localStorage key holding the SP permission policy blob in the browser. */
export const SP_PERMS_STORAGE_KEY = "scm_sp_perms";

/** The boolean permission keys we gate on. */
export type SpPermissionKey =
  | "canManagePlans"
  | "canApprovePayouts"
  | "canExportReports";

/** The permission policy shape SP returns (all fields optional / best-effort). */
export interface SpPermissions {
  canManagePlans?: boolean;
  maxPlans?: number | null;
  canApprovePayouts?: boolean;
  canExportReports?: boolean;
}

interface SpPermissionsCtx {
  /** True only when a valid SP policy blob is present (i.e. launched from SP). */
  embedded: boolean;
  /** The raw parsed policy, or null when standalone. */
  permissions: SpPermissions | null;
  /**
   * Whether a boolean permission is granted. When standalone (no blob) this is
   * always `true`. An absent key defaults to `defaultAllow` (true).
   */
  can: (key: SpPermissionKey, defaultAllow?: boolean) => boolean;
  /** The plan cap, or `null` when unlimited (standalone, absent, or null). */
  maxPlans: () => number | null;
}

const Ctx = createContext<SpPermissionsCtx | null>(null);

/** Read + parse the SP policy blob from localStorage. Fails open (null). */
function readPolicy(): SpPermissions | null {
  try {
    const raw = window.localStorage.getItem(SP_PERMS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as SpPermissions;
  } catch {
    return null; // fail open
  }
}

export function SpPermissionsProvider({ children }: { children: ReactNode }) {
  // Read once at mount. The blob is written by the launch handoff before the
  // SPA boots and is stable for the life of the session, so there is no need to
  // subscribe to changes.
  const permissions = useMemo(() => readPolicy(), []);

  const value = useMemo<SpPermissionsCtx>(() => {
    const embedded = permissions !== null;
    return {
      embedded,
      permissions,
      can: (key: SpPermissionKey, defaultAllow = true) => {
        if (!permissions) return true; // standalone → everything allowed
        const v = permissions[key];
        return typeof v === "boolean" ? v : defaultAllow;
      },
      maxPlans: () => {
        if (!permissions) return null; // standalone → unlimited
        const v = permissions.maxPlans;
        return typeof v === "number" && Number.isFinite(v) ? v : null;
      },
    };
  }, [permissions]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSpPermissions(): SpPermissionsCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSpPermissions must be used inside <SpPermissionsProvider>");
  return ctx;
}
