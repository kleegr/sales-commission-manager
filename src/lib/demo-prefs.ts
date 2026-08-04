// ============================================================================
// REVIEW-MODE PREFERENCES  (browser)
//
// Review/demo mode lets a reviewer pick the tenant + role to view from the top
// bar. That choice used to travel ONLY as the `scm_demo_tenant` /
// `scm_demo_role` cookies — the same third-party cookies a mobile WebView
// blocks inside the Kleegr iframe, so a framed reviewer silently fell back to
// the server's default (tenant "demo", role "owner") no matter what they
// picked.
//
// The server has always accepted `x-demo-tenant` / `x-demo-role` HEADERS as
// well (see getDemoUser() in api/_lib/auth.ts). This module keeps the choice in
// localStorage — first-party to this origin, iframe or not — so src/lib/
// api-auth.ts can replay it as those headers, exactly as it replays the session
// token as `Authorization: Bearer …`. The cookies are still written, so
// non-JS/legacy paths behave as before.
//
// This grants NO new authority: the server only honours these at all when
// DEMO_MODE is explicitly enabled, and it can only ever resolve one of the
// seeded demo tenants (DEMO_TENANT_SLUGS) — never a real customer workspace.
//
// Every access is wrapped: some WebViews and Safari Private Browsing throw on
// `window.localStorage` rather than returning null, and a throw here must
// degrade to "no preference", never to a crashed app shell.
// ============================================================================

export const DEMO_TENANT_KEY = "scm_demo_tenant";
export const DEMO_ROLE_KEY = "scm_demo_role";

export interface DemoPrefs {
  tenantSlug: string | null;
  role: string | null;
}

function store(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function read(key: string): string | null {
  try {
    const v = store()?.getItem(key);
    return v && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

/** The review-mode tenant + role this browser last selected. */
export function readDemoPrefs(): DemoPrefs {
  return { tenantSlug: read(DEMO_TENANT_KEY), role: read(DEMO_ROLE_KEY) };
}

/** Remember the review-mode selection so it survives inside the iframe. */
export function storeDemoPrefs(tenantSlug: string, role: string): void {
  try {
    const s = store();
    if (!s) return;
    if (tenantSlug.trim()) s.setItem(DEMO_TENANT_KEY, tenantSlug.trim());
    if (role.trim()) s.setItem(DEMO_ROLE_KEY, role.trim());
  } catch {
    /* storage unavailable — the cookies still carry the choice */
  }
}

/** Forget the selection (logout). */
export function clearDemoPrefs(): void {
  try {
    const s = store();
    s?.removeItem(DEMO_TENANT_KEY);
    s?.removeItem(DEMO_ROLE_KEY);
  } catch {
    /* nothing to clear */
  }
}
